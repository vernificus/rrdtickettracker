const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'rrd_ticket_tracker_secret_jwt_key_2026_change_in_production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'data4life';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!SPREADSHEET_ID) {
  console.error("WARNING: SPREADSHEET_ID environment variable is not defined!");
}

app.use(cors());
app.use(express.json());

// --- Private Key Formatter for flattened GCP Environment Keys ---
function formatPrivateKey(key) {
  if (!key) return null;
  
  // If it's already in a proper multiline format, return it
  if (key.includes('\n') && key.includes('-----BEGIN')) {
    return key.replace(/\\n/g, '\n');
  }

  // Extract base64 content
  let cleaned = key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, ''); // remove all spaces and newlines

  // Chunk into 64-char lines
  const chunks = [];
  for (let i = 0; i < cleaned.length; i += 64) {
    chunks.push(cleaned.substring(i, i + 64));
  }

  return `-----BEGIN PRIVATE KEY-----\n${chunks.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

// --- Google Sheets DB Layer ---
class GoogleSheetsDb {
  constructor(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.useFallback = false;
    this.cache = new Map();
    this.inFlight = new Map();
    this.cacheTTL = 60000; // 60s in-memory cache TTL (invalidated on writes)
    this.fallbackDb = {
      Users: [],
      Students: [],
      Tickets: [],
      GoldenTickets: [],
      Spending: [],
      ClassGoals: [],
      GradeGoals: [],
      RaffleWinners: []
    };
  }

  loadFallback() {
    const filePath = path.join(__dirname, 'db_local.json');
    if (fs.existsSync(filePath)) {
      try {
        this.fallbackDb = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.error("Failed to read local fallback db:", e.message);
      }
    }
  }

  saveFallback() {
    const filePath = path.join(__dirname, 'db_local.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify(this.fallbackDb, null, 2), 'utf8');
    } catch (e) {
      console.error("Failed to write local fallback db:", e.message);
    }
  }

  async init() {
    this.loadFallback();
    let auth;

    // 1. Try GOOGLE_PRIVATE_KEY and GOOGLE_SERVICE_ACCOUNT_EMAIL
    if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      try {
        const privateKey = formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY);
        auth = new google.auth.JWT({
          email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(),
          key: privateKey,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        console.log("Authenticated Google Sheets API using GOOGLE_SERVICE_ACCOUNT_EMAIL and formatted GOOGLE_PRIVATE_KEY");
      } catch (e) {
        console.error("Failed to authenticate using key environment variables:", e.message);
      }
    }

    // 2. Try GCP_SERVICE_ACCOUNT_KEY
    if (!auth && process.env.GCP_SERVICE_ACCOUNT_KEY) {
      try {
        const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
        auth = google.auth.fromJSON(credentials);
        auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];
        console.log("Authenticated Google Sheets API using GCP_SERVICE_ACCOUNT_KEY from env");
      } catch (e) {
        console.error("Failed to parse GCP_SERVICE_ACCOUNT_KEY from environment, falling back to ADC:", e.message);
      }
    }

    // 3. Fallback to ADC
    if (!auth) {
      try {
        auth = new google.auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        console.log("Authenticated Google Sheets API using Application Default Credentials (ADC)");
      } catch (e) {
        console.warn("ADC not available, switching to local JSON database fallback:", e.message);
        this.useFallback = true;
        return;
      }
    }

    try {
      this.sheets = google.sheets({ version: 'v4', auth });
      // Use 15s timeout for ensureTables on cold starts
      await Promise.race([
        this.ensureTables(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Google Sheets connection timed out')), 15000))
      ]);
    } catch (e) {
      console.warn("Google Sheets connection failed/timed out during initialization:", e.message);
      const isQuotaOrTransient = e.status === 429 || (e.message && (e.message.includes('Quota exceeded') || e.message.includes('RESOURCE_EXHAUSTED')));
      if (!isQuotaOrTransient && !auth) {
        console.warn("Switching to local JSON database fallback.");
        this.useFallback = true;
      } else {
        console.warn("Keeping live connection active for subsequent retries.");
      }
    }
  }

  async ensureTables() {
    const requiredSheets = [
      { name: 'Users', headers: ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'] },
      { name: 'Students', headers: ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'] },
      { name: 'Tickets', headers: ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'] },
      { name: 'GoldenTickets', headers: ['Id', 'TeacherEmail', 'TeacherName', 'ClassName', 'Timestamp'] },
      { name: 'Spending', headers: ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'Amount', 'Item', 'Timestamp'] },
      { name: 'ClassGoals', headers: ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'] },
      { name: 'GradeGoals', headers: ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'] },
      { name: 'RaffleWinners', headers: ['Id', 'WinnerName', 'WinnerType', 'Homeroom', 'Grade', 'TicketCount', 'DrawnByEmail', 'DrawnByName', 'Scope', 'Timestamp'] }
    ];

    try {
      const ss = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const existingSheetNames = ss.data.sheets.map(s => s.properties.title);

      for (const req of requiredSheets) {
        if (!existingSheetNames.includes(req.name)) {
          console.log(`Creating sheet worksheet: ${req.name}`);
          await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            resource: {
              requests: [
                {
                  addSheet: {
                    properties: { title: req.name }
                  }
                }
              ]
            }
          });
          // Write headers immediately
          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${req.name}!A1`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [req.headers] }
          });
        }
      }

      // Verify headers in existing sheets using 1 single batchGet call
      const existingReqs = requiredSheets.filter(r => existingSheetNames.includes(r.name));
      if (existingReqs.length > 0) {
        const headerRanges = existingReqs.map(r => `${r.name}!A1:Z1`);
        const headerBatch = await this.sheets.spreadsheets.values.batchGet({
          spreadsheetId: this.spreadsheetId,
          ranges: headerRanges
        });
        const valueRanges = headerBatch.data.valueRanges || [];
        for (let i = 0; i < existingReqs.length; i++) {
          const req = existingReqs[i];
          const vr = valueRanges[i];
          const currentHeaders = (vr && vr.values && vr.values[0]) ? vr.values[0] : [];
          const missingHeader = req.headers.some(h => !currentHeaders.map(x => (x || '').trim().toLowerCase()).includes(h.toLowerCase()));
          if (missingHeader) {
            console.log(`Updating schema headers for existing sheet ${req.name}...`);
            await this.sheets.spreadsheets.values.update({
              spreadsheetId: this.spreadsheetId,
              range: `${req.name}!A1`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [req.headers] }
            });
          }
        }
      }
      console.log("All database tables are verified and active.");
    } catch (e) {
      console.error("Error communicating with Google Sheets in ensureTables:", e.message);
      const isQuotaOrTransient = e.status === 429 || (e.message && (e.message.includes('Quota exceeded') || e.message.includes('RESOURCE_EXHAUSTED')));
      if (!isQuotaOrTransient) {
        console.error("Make sure your Sheet is shared with the service account and SPREADSHEET_ID is correct.");
        console.warn("Switching to local JSON database fallback.");
        this.useFallback = true;
      } else {
        console.warn("Quota limit encountered during table verification. Retaining live connection.");
      }
    }
  }

  invalidateCache(sheetName) {
    if (sheetName) {
      this.cache.delete(sheetName);
    } else {
      this.cache.clear();
    }
  }

  async withRetry(operation, maxRetries = 4, initialDelayMs = 1000) {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        const isRateLimitOrTransient =
          err.code === 429 ||
          err.status === 429 ||
          (err.message && (
            err.message.includes('Quota exceeded') ||
            err.message.includes('Rate limit') ||
            err.message.includes('RESOURCE_EXHAUSTED') ||
            err.message.includes('503') ||
            err.message.includes('500') ||
            err.message.includes('socket hang up') ||
            err.message.includes('ECONNRESET')
          ));

        if (attempt < maxRetries && isRateLimitOrTransient) {
          console.warn(`[Google Sheets API] Rate limit/transient error on attempt ${attempt}/${maxRetries}. Retrying in ${delay}ms...`);
          await new Promise(res => setTimeout(res, delay));
          delay *= 2;
        } else {
          throw err;
        }
      }
    }
  }

  async getMultipleSheets(sheetNames) {
    if (this.useFallback) {
      const out = {};
      sheetNames.forEach(name => {
        out[name] = this.fallbackDb[name] || [];
      });
      return out;
    }

    const results = {};
    const sheetsToFetch = [];

    // 1. Check in-memory cache
    sheetNames.forEach(name => {
      const cached = this.cache.get(name);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        results[name] = JSON.parse(JSON.stringify(cached.data));
      } else {
        sheetsToFetch.push(name);
      }
    });

    if (sheetsToFetch.length === 0) {
      return results;
    }

    // 2. Wait on any in-flight fetches for these sheets if available
    const pendingPromises = [];
    const genuinelyUnfetched = [];
    sheetsToFetch.forEach(name => {
      if (this.inFlight.has(name)) {
        pendingPromises.push(
          this.inFlight.get(name).then(data => {
            results[name] = JSON.parse(JSON.stringify(data));
          })
        );
      } else {
        genuinelyUnfetched.push(name);
      }
    });

    if (genuinelyUnfetched.length > 0) {
      let resolvePromise, rejectPromise;
      const batchPromise = new Promise((res, rej) => {
        resolvePromise = res;
        rejectPromise = rej;
      });

      // Mark genuinely unfetched sheets as in-flight
      genuinelyUnfetched.forEach(name => {
        this.inFlight.set(name, batchPromise.then(() => this.cache.get(name)?.data || []));
      });

      const executeFetch = (async () => {
        try {
          const ranges = genuinelyUnfetched.map(name => `${name}!A1:Z`);
          const res = await this.withRetry(() => this.sheets.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges
          }));

          const valueRanges = res.data.valueRanges || [];
          genuinelyUnfetched.forEach((sheetName, index) => {
            const vr = valueRanges[index];
            const rows = (vr && vr.values) ? vr.values : [];
            if (!rows || rows.length < 2) {
              this.cache.set(sheetName, { data: [], timestamp: Date.now() });
              results[sheetName] = [];
              return;
            }

            const headers = rows[0].map(h => (h || '').trim());
            const parsed = rows.slice(1).map((row, rowIndex) => {
              const obj = { _rowNum: rowIndex + 2 };
              headers.forEach((h, colIndex) => {
                if (!h) return;
                const key = h.charAt(0).toLowerCase() + h.slice(1);
                obj[key] = row[colIndex] !== undefined ? row[colIndex] : '';
              });
              if (sheetName === 'Users' && !obj.coTaughtHomerooms && row[5] !== undefined) {
                obj.coTaughtHomerooms = row[5];
              }
              return obj;
            });

            this.cache.set(sheetName, { data: parsed, timestamp: Date.now() });
            results[sheetName] = JSON.parse(JSON.stringify(parsed));
          });
          resolvePromise();
        } catch (e) {
          rejectPromise(e);
          throw e;
        } finally {
          genuinelyUnfetched.forEach(name => {
            this.inFlight.delete(name);
          });
        }
      })();

      pendingPromises.push(executeFetch);
    }

    await Promise.all(pendingPromises);
    return results;
  }

  async getRows(sheetName) {
    const data = await this.getMultipleSheets([sheetName]);
    return data[sheetName] || [];
  }

  async appendRow(sheetName, headers, rowObj) {
    this.invalidateCache(sheetName);
    if (this.useFallback) {
      if (!this.fallbackDb[sheetName]) this.fallbackDb[sheetName] = [];
      const _rowNum = this.fallbackDb[sheetName].length + 2;
      const copy = { ...rowObj, _rowNum };
      this.fallbackDb[sheetName].push(copy);
      this.saveFallback();
      return;
    }
    try {
      const values = headers.map(h => {
        const key = h.charAt(0).toLowerCase() + h.slice(1);
        return rowObj[key] !== undefined ? rowObj[key] : '';
      });
      await this.withRetry(() => this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      }));
    } catch (e) {
      console.error(`Error appending to sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async appendRows(sheetName, headers, rowObjects) {
    this.invalidateCache(sheetName);
    if (this.useFallback) {
      if (!this.fallbackDb[sheetName]) this.fallbackDb[sheetName] = [];
      rowObjects.forEach(rowObj => {
        const _rowNum = this.fallbackDb[sheetName].length + 2;
        const copy = { ...rowObj, _rowNum };
        this.fallbackDb[sheetName].push(copy);
      });
      this.saveFallback();
      return;
    }
    try {
      const allValues = rowObjects.map(rowObj => {
        return headers.map(h => {
          const key = h.charAt(0).toLowerCase() + h.slice(1);
          return rowObj[key] !== undefined ? rowObj[key] : '';
        });
      });
      await this.withRetry(() => this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: allValues }
      }));
    } catch (e) {
      console.error(`Error appending multiple rows to sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async updateRow(sheetName, headers, rowNum, rowObj) {
    this.invalidateCache(sheetName);
    if (this.useFallback) {
      const list = this.fallbackDb[sheetName] || [];
      const idx = list.findIndex(r => r._rowNum === rowNum);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...rowObj };
        this.saveFallback();
      }
      return;
    }
    try {
      const values = headers.map(h => {
        const key = h.charAt(0).toLowerCase() + h.slice(1);
        return rowObj[key] !== undefined ? rowObj[key] : '';
      });
      await this.withRetry(() => this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      }));
    } catch (e) {
      console.error(`Error updating row ${rowNum} in sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async deleteRow(sheetName, rowNum) {
    this.invalidateCache(sheetName);
    if (this.useFallback) {
      let list = this.fallbackDb[sheetName] || [];
      list = list.filter(r => r._rowNum !== rowNum);
      // Re-assign rowNums to keep consistency
      list.forEach((r, idx) => {
        r._rowNum = idx + 2;
      });
      this.fallbackDb[sheetName] = list;
      this.saveFallback();
      return;
    }
    try {
      const ssMeta = await this.withRetry(() => this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId }));
      const sheet = ssMeta.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) throw new Error(`Sheet worksheet ${sheetName} not found`);
      const sheetId = sheet.properties.sheetId;

      await this.withRetry(() => this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowNum - 1,
                  endIndex: rowNum
                }
              }
            }
          ]
        }
      }));
    } catch (e) {
      console.error(`Error deleting row ${rowNum} in sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async clearSheet(sheetName) {
    this.invalidateCache(sheetName);
    if (this.useFallback) {
      this.fallbackDb[sheetName] = [];
      this.saveFallback();
      return;
    }
    try {
      await this.withRetry(() => this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:Z`
      }));
    } catch (e) {
      console.error(`Error clearing sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async setAllRows(sheetName, headers, rowObjects) {
    if (this.useFallback) {
      const copy = rowObjects.map((rowObj, idx) => ({
        ...rowObj,
        _rowNum: idx + 2
      }));
      this.fallbackDb[sheetName] = copy;
      this.saveFallback();
      return;
    }
    try {
      const allValues = rowObjects.map(rowObj => {
        return headers.map(h => {
          const key = h.charAt(0).toLowerCase() + h.slice(1);
          return rowObj[key] !== undefined ? rowObj[key] : '';
        });
      });

      // Clear existing data rows starting from row 2
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2:Z`
      });

      // If there are rows to write, write them starting at A2
      if (allValues.length > 0) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${sheetName}!A2`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: allValues }
        });
      }
    } catch (e) {
      console.error(`Error setting all rows in sheet ${sheetName}:`, e.message);
      throw e;
    }
  }
}

const db = new GoogleSheetsDb(SPREADSHEET_ID);

// --- Password Hashing Utilities ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const verifyHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
}

// --- Auth Middleware ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Authorization required' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired session' });
    req.user = decoded;
    next();
  });
}

// --- Authentication APIs ---

// Teacher Login
app.post('/api/auth/teacher', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => (u.email || '').trim().toLowerCase() === email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, profile: { email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error("Error during teacher login:", err);
    res.status(500).json({ message: 'Server error during authentication. Please try again.' });
  }
});

// Teacher Self-Registration
app.post('/api/auth/teacher/register', async (req, res) => {
  const { email, password, name, role, adminPassword } = req.body;
  if (!email || !password || !name || !role) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  // Require admin password when registering as admin
  if (role === 'admin' && adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ message: 'Invalid admin password. Contact your administrator for the correct password.' });
  }

  try {
    const users = await db.getRows('Users');
    const existing = users.find(u => (u.email || '').trim().toLowerCase() === email.trim().toLowerCase());
    if (existing) {
      return res.status(400).json({ message: 'A teacher with this email already exists' });
    }

    const hashedPassword = hashPassword(password);
    const newUser = {
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: role.trim(),
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      coTaughtHomerooms: '[]'
    };
    await db.appendRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], newUser);
    res.json({ message: 'Registration successful! You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// Teacher Forgot/Reset Password (public self-service)
app.post('/api/auth/teacher/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res.status(400).json({ message: 'Email and new password are required.' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ message: 'Password must be at least 4 characters.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => (u.email || '').trim().toLowerCase() === email.trim().toLowerCase());
    if (!user) {
      return res.status(404).json({ message: 'No teacher account found with this email. Please check your email or register.' });
    }

    user.password = hashPassword(newPassword);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);
    res.json({ success: true, message: 'Password reset successfully! You can now log in.' });
  } catch (err) {
    console.error("Error resetting teacher password:", err);
    res.status(500).json({ message: 'Server error resetting password.' });
  }
});

// Authenticated user change password
app.post('/api/auth/reset-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current password and new password are required.' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ message: 'New password must be at least 4 characters.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }

    user.password = hashPassword(newPassword);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);
    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    console.error("Error changing password:", err);
    res.status(500).json({ message: 'Server error changing password.' });
  }
});

// Change Role (authenticated users)
app.post('/api/auth/change-role', authMiddleware, async (req, res) => {
  const { newRole, adminPassword } = req.body;
  if (!newRole || !['admin', 'homeroom', 'specialist'].includes(newRole)) {
    return res.status(400).json({ message: 'Valid role required (admin, homeroom, or specialist).' });
  }

  // Require admin password when switching to admin
  if (newRole === 'admin' && adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ message: 'Invalid admin password.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
    if (!user) return res.status(404).json({ message: 'User profile not found.' });

    // Update the role in the sheet
    user.role = newRole;
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);

    let coTaught = [];
    try {
      coTaught = user.coTaughtHomerooms ? JSON.parse(user.coTaughtHomerooms) : [];
    } catch (e) {
      coTaught = typeof user.coTaughtHomerooms === 'string' ? user.coTaughtHomerooms.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    // Issue a new JWT with the updated role
    const token = jwt.sign({ email: user.email, role: newRole, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, profile: { email: user.email, name: user.name, role: newRole, coTaughtHomerooms: coTaught } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error changing role.' });
  }
});

// Share Class / Manage Co-Teachers endpoint
app.post('/api/teachers/share-class', authMiddleware, async (req, res) => {
  const { targetEmail, homeroomName, action } = req.body; // action: 'add' | 'remove'
  if (!homeroomName) {
    return res.status(400).json({ message: 'Homeroom name is required.' });
  }

  try {
    const users = await db.getRows('Users');
    const emailToModify = targetEmail ? targetEmail.toLowerCase() : req.user.email.toLowerCase();
    const user = users.find(u => u.email.toLowerCase() === emailToModify);
    if (!user) return res.status(404).json({ message: 'Teacher profile not found.' });

    let currentShared = [];
    try {
      currentShared = user.coTaughtHomerooms ? JSON.parse(user.coTaughtHomerooms) : [];
    } catch (e) {
      currentShared = typeof user.coTaughtHomerooms === 'string' ? user.coTaughtHomerooms.split(',').map(s => s.trim()) : [];
    }

    if (action === 'remove') {
      currentShared = currentShared.filter(h => h.toLowerCase() !== homeroomName.toLowerCase());
    } else {
      if (!currentShared.some(h => h.toLowerCase() === homeroomName.toLowerCase())) {
        currentShared.push(homeroomName);
      }
    }

    user.coTaughtHomerooms = JSON.stringify(currentShared);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);

    res.json({ success: true, coTaughtHomerooms: currentShared });
  } catch (err) {
    console.error("Error updating shared classes:", err);
    res.status(500).json({ message: 'Server error updating shared classes.' });
  }
});

// Admin Manage Co-Teachers endpoint
app.post('/api/admin/manage-coteachers', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin privileges required.' });
  }
  const { targetEmail, homeroomName, action, coTaughtHomerooms } = req.body;
  if (!targetEmail) {
    return res.status(400).json({ message: 'Target teacher email is required.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => u.email.toLowerCase() === targetEmail.toLowerCase().trim());
    if (!user) return res.status(404).json({ message: 'Teacher profile not found.' });

    let currentShared = [];
    if (Array.isArray(coTaughtHomerooms)) {
      currentShared = coTaughtHomerooms.map(h => String(h).trim()).filter(Boolean);
    } else {
      try {
        currentShared = user.coTaughtHomerooms ? JSON.parse(user.coTaughtHomerooms) : [];
      } catch (e) {
        currentShared = typeof user.coTaughtHomerooms === 'string' ? user.coTaughtHomerooms.split(',').map(s => s.trim()).filter(Boolean) : [];
      }
      if (homeroomName) {
        if (action === 'remove') {
          currentShared = currentShared.filter(h => h.toLowerCase() !== homeroomName.toLowerCase().trim());
        } else {
          if (!currentShared.some(h => h.toLowerCase() === homeroomName.toLowerCase().trim())) {
            currentShared.push(homeroomName.trim());
          }
        }
      }
    }

    user.coTaughtHomerooms = JSON.stringify(currentShared);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);

    res.json({ success: true, message: `Updated co-taught classes for ${user.name || user.email}.`, coTaughtHomerooms: currentShared });
  } catch (err) {
    console.error("Error managing co-teachers:", err);
    res.status(500).json({ message: 'Server error managing co-teachers.' });
  }
});

// Admin Reset Teacher Password endpoint
app.post('/api/admin/reset-teacher-password', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin privileges required.' });
  }
  const { targetEmail, newPassword } = req.body;
  if (!targetEmail || !newPassword) {
    return res.status(400).json({ message: 'Teacher email and new password are required.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => u.email.toLowerCase() === targetEmail.toLowerCase());
    if (!user) return res.status(404).json({ message: 'Teacher profile not found.' });

    user.password = hashPassword(newPassword);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);
    res.json({ success: true, message: `Password for ${user.name || user.email} updated successfully.` });
  } catch (err) {
    console.error("Error resetting teacher password:", err);
    res.status(500).json({ message: 'Server error resetting teacher password.' });
  }
});

// Student Login
app.post('/api/auth/student', async (req, res) => {
  const { studentId, pinCode } = req.body;
  if (!studentId || !pinCode) {
    return res.status(400).json({ message: 'Student ID and PIN are required' });
  }

  try {
    const students = await db.getRows('Students');
    const student = students.find(s => s.id.toUpperCase() === studentId.trim().toUpperCase());
    if (!student || student.pinCode !== pinCode.trim()) {
      return res.status(401).json({ message: 'Invalid Student ID or PIN' });
    }

    const token = jwt.sign({ studentId: student.id, name: student.name, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, profile: { id: student.id, name: student.name, role: 'student', homeroom: student.homeroom, grade: student.grade } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during student authentication' });
  }
});

// --- Main Data fetching API ---
app.get('/api/initial-data', authMiddleware, async (req, res) => {
  try {
    const role = req.user.role;

    // Student Dashboard view
    if (role === 'student') {
      const studentId = req.user.studentId;
      const sheetsData = await db.getMultipleSheets(['Students', 'Tickets', 'Spending', 'ClassGoals', 'GradeGoals', 'GoldenTickets']);
      const allStudents = sheetsData.Students || [];
      const allTickets = sheetsData.Tickets || [];
      const allSpending = sheetsData.Spending || [];
      const classGoals = sheetsData.ClassGoals || [];
      const gradeGoals = sheetsData.GradeGoals || [];
      const allGolden = sheetsData.GoldenTickets || [];

      const student = allStudents.find(s => s.id === studentId);
      if (!student) return res.status(404).json({ message: 'Student profile not found' });

      const studentTickets = allTickets.filter(t => t.recipient === student.name && t.recipientType === 'student');
      const studentSpending = allSpending.filter(s => s.recipient === student.name);
      const classGoal = classGoals.find(g => g.className === student.homeroom) || null;
      const gradeGoal = gradeGoals.find(g => g.grade === student.grade) || null;
      const goldenTickets = allGolden.filter(g => g.className === student.homeroom);

      const earned = studentTickets.length;
      const spent = studentSpending.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      const balance = earned - spent;

      // Calculations for class goals and grade goals progress
      const homeroomStudents = allStudents.filter(s => s.homeroom === student.homeroom).map(s => s.name);
      const classTicketsEarned = allTickets.filter(t => t.recipientType === 'student' && homeroomStudents.includes(t.recipient)).length;

      const classesInGrade = new Set(allStudents.filter(s => s.grade === student.grade).map(s => s.homeroom));
      const gradeGoldenEarned = allGolden.filter(g => classesInGrade.has(g.className)).length;

      return res.json({
        role: 'student',
        profile: student,
        tickets: studentTickets,
        spending: studentSpending,
        classGoal,
        gradeGoal,
        wallet: { earned, spent, balance },
        goldenCount: goldenTickets.length,
        classTicketsEarned,
        gradeGoldenEarned
      });
    }

    // Teacher / Admin Dashboard view
    const email = (req.user.email || '').trim().toLowerCase();
    const sheetsData = await db.getMultipleSheets([
      'Users',
      'Students',
      'GoldenTickets',
      'ClassGoals',
      'GradeGoals',
      'Tickets',
      'Spending',
      'RaffleWinners'
    ]);
    const profiles = sheetsData.Users || [];
    const students = sheetsData.Students || [];
    const goldenTickets = sheetsData.GoldenTickets || [];
    const classGoals = sheetsData.ClassGoals || [];
    const gradeGoals = sheetsData.GradeGoals || [];
    const allTickets = sheetsData.Tickets || [];
    const allSpending = sheetsData.Spending || [];
    const raffleWinners = sheetsData.RaffleWinners || [];

    const profile = profiles.find(p => (p.email || '').trim().toLowerCase() === email);
    if (!profile) return res.status(404).json({ message: 'Teacher profile not found' });

    delete profile.password; // remove sensitive field
    try {
      profile.coTaughtHomerooms = profile.coTaughtHomerooms ? JSON.parse(profile.coTaughtHomerooms) : [];
    } catch (e) {
      profile.coTaughtHomerooms = typeof profile.coTaughtHomerooms === 'string' ? profile.coTaughtHomerooms.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    let tickets = allTickets;
    let spending = allSpending;

    // Calculate global balances for all students (so teachers can spend against student balances safely)
    const balances = {};
    tickets.forEach(t => {
      if (t.recipientType === 'student') {
        if (!balances[t.recipient]) {
          balances[t.recipient] = { earned: 0, spent: 0, Respectful: 0, Responsible: 0, Determined: 0 };
        }
        balances[t.recipient].earned++;
        if (t.reason && balances[t.recipient][t.reason] !== undefined) {
          balances[t.recipient][t.reason]++;
        }
      }
    });
    spending.forEach(s => {
      if (!balances[s.recipient]) {
        balances[s.recipient] = { earned: 0, spent: 0, Respectful: 0, Responsible: 0, Determined: 0 };
      }
      balances[s.recipient].spent += Number(s.amount || 0);
    });

    const activeRole = (req.user && req.user.role) ? req.user.role : profile.role;
    profile.role = activeRole;

    // Visibility rules: Specialists and Homerooms see tickets/spending they or their co-teachers created
    // Admins see all tickets/spending
    if (activeRole !== 'admin') {
      const allowedEmails = new Set([email]);
      const myName = (profile.name || '').trim().toLowerCase();
      const myCoTaught = Array.isArray(profile.coTaughtHomerooms) ? profile.coTaughtHomerooms.map(h => (h || '').trim().toLowerCase()) : [];

      profiles.forEach(p => {
        const pEmail = (p.email || '').trim().toLowerCase();
        const pName = (p.name || '').trim().toLowerCase();
        let pCoTaught = [];
        try { pCoTaught = p.coTaughtHomerooms ? JSON.parse(p.coTaughtHomerooms) : []; } catch (e) {}
        const pCoLower = pCoTaught.map(h => (h || '').trim().toLowerCase());

        // 1. Other teacher lists current user's name or email in their coTaughtHomerooms
        if (pCoLower.some(h => h === myName || h === email)) {
          allowedEmails.add(pEmail);
        }
        // 2. Current user lists other teacher's name or email in their coTaughtHomerooms
        if (myCoTaught.some(h => h === pName || h === pEmail)) {
          allowedEmails.add(pEmail);
        }
      });
      tickets = tickets.filter(t => allowedEmails.has((t.teacherEmail || '').trim().toLowerCase()));
      spending = spending.filter(s => allowedEmails.has((s.teacherEmail || '').trim().toLowerCase()));
    }

    const sanitizedProfiles = profiles.map(p => {
      const copy = { ...p };
      delete copy.password;
      try { copy.coTaughtHomerooms = copy.coTaughtHomerooms ? JSON.parse(copy.coTaughtHomerooms) : []; } catch (e) {}
      return copy;
    });

    res.json({
      role: activeRole,
      profile,
      profiles: sanitizedProfiles,
      students,
      tickets,
      goldenTickets,
      spending,
      classGoals,
      gradeGoals,
      balances,
      raffleWinners
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to retrieve initial data' });
  }
});

// --- Behavior Tickets CRUD ---
app.post('/api/tickets/batch', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const rawTickets = req.body.tickets || req.body.items || (Array.isArray(req.body) ? req.body : []);
  if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
    return res.status(400).json({ message: 'No tickets provided in batch' });
  }

  try {
    const newTickets = rawTickets.map(t => {
      const { recipient, recipientType = 'student', reason = 'Respectful', customDate } = t;
      const id = crypto.randomUUID();
      let timestamp = new Date().toISOString();
      if (customDate) {
        const d = new Date(String(customDate) + 'T12:00:00');
        if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
          timestamp = d.toISOString();
        }
      }
      return {
        id,
        teacherEmail: req.user.email,
        teacherName: req.user.name,
        recipient: (recipient || '').trim(),
        recipientType,
        reason,
        timestamp
      };
    }).filter(t => t.recipient);

    if (newTickets.length === 0) {
      return res.status(400).json({ message: 'Missing valid ticket recipients' });
    }

    await db.appendRows('Tickets', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'], newTickets);
    res.json({ success: true, count: newTickets.length, tickets: newTickets });
  } catch (err) {
    console.error('Batch tickets save error:', err);
    res.status(500).json({ message: 'Error saving batch behavior tickets' });
  }
});

app.post('/api/tickets', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });

  // If request contains an array or batch of tickets, handle as batch
  if (Array.isArray(req.body.tickets) || Array.isArray(req.body.items) || Array.isArray(req.body)) {
    const rawTickets = req.body.tickets || req.body.items || req.body;
    try {
      const newTickets = rawTickets.map(t => {
        const { recipient, recipientType = 'student', reason = 'Respectful', customDate } = t;
        const id = crypto.randomUUID();
        let timestamp = new Date().toISOString();
        if (customDate) {
          const d = new Date(String(customDate) + 'T12:00:00');
          if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
            timestamp = d.toISOString();
          }
        }
        return {
          id,
          teacherEmail: req.user.email,
          teacherName: req.user.name,
          recipient: (recipient || '').trim(),
          recipientType,
          reason,
          timestamp
        };
      }).filter(t => t.recipient);

      if (newTickets.length === 0) {
        return res.status(400).json({ message: 'Missing valid ticket recipients' });
      }

      await db.appendRows('Tickets', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'], newTickets);
      return res.json({ success: true, count: newTickets.length, tickets: newTickets });
    } catch (err) {
      console.error('Batch tickets save error in /api/tickets:', err);
      return res.status(500).json({ message: 'Error saving behavior tickets' });
    }
  }

  const { recipient, recipientType, reason, customDate } = req.body;
  if (!recipient || !recipientType || !reason) {
    return res.status(400).json({ message: 'Missing recipient, type, or reason' });
  }

  try {
    const id = crypto.randomUUID();
    let timestamp = new Date().toISOString();
    if (customDate) {
      const d = new Date(String(customDate) + 'T12:00:00');
      if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
        timestamp = d.toISOString();
      }
    }

    const newTicket = {
      id,
      teacherEmail: req.user.email,
      teacherName: req.user.name,
      recipient,
      recipientType,
      reason,
      timestamp
    };

    await db.appendRow('Tickets', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'], newTicket);
    res.json(newTicket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error saving behavior ticket' });
  }
});

app.delete('/api/tickets/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const ticketId = req.params.id;

  try {
    const tickets = await db.getRows('Tickets');
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    if (req.user.role !== 'admin' && ticket.teacherEmail !== req.user.email) {
      return res.status(403).json({ message: 'You can only delete entries you created' });
    }

    await db.deleteRow('Tickets', ticket._rowNum);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error removing behavior ticket' });
  }
});

// --- Golden Tickets CRUD ---
app.post('/api/golden-tickets', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const { className } = req.body;
  if (!className) return res.status(400).json({ message: 'Class name is required' });

  try {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const newGT = {
      id,
      teacherEmail: req.user.email,
      teacherName: req.user.name,
      className,
      timestamp
    };

    await db.appendRow('GoldenTickets', ['Id', 'TeacherEmail', 'TeacherName', 'ClassName', 'Timestamp'], newGT);
    res.json(newGT);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error saving golden ticket' });
  }
});

app.delete('/api/golden-tickets/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const ticketId = req.params.id;

  try {
    const goldenTickets = await db.getRows('GoldenTickets');
    const gt = goldenTickets.find(g => g.id === ticketId);
    if (!gt) return res.status(404).json({ message: 'Golden ticket not found' });

    if (req.user.role !== 'admin' && gt.teacherEmail !== req.user.email) {
      return res.status(403).json({ message: 'You can only delete golden tickets you created' });
    }

    await db.deleteRow('GoldenTickets', gt._rowNum);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error deleting golden ticket' });
  }
});

// --- Goals CRUD ---
app.post('/api/class-goals', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const { className, goalTickets, rewardText } = req.body;
  if (!className || !goalTickets || !rewardText) {
    return res.status(400).json({ message: 'Missing className, goalTickets, or rewardText' });
  }

  try {
    const goals = await db.getRows('ClassGoals');
    const existing = goals.find(g => g.className.toLowerCase() === className.toLowerCase());
    const payload = {
      className,
      goalTickets: Number(goalTickets),
      rewardText,
      timestamp: new Date().toISOString()
    };
    if (existing) {
      await db.updateRow('ClassGoals', ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'], existing._rowNum, payload);
    } else {
      await db.appendRow('ClassGoals', ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'], payload);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save class goal' });
  }
});

app.post('/api/grade-goals', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Unauthorized' });
  const { grade, goalGolden, rewardText } = req.body;
  if (!grade || !goalGolden || !rewardText) {
    return res.status(400).json({ message: 'Missing grade, goalGolden, or rewardText' });
  }

  try {
    const goals = await db.getRows('GradeGoals');
    const existing = goals.find(g => String(g.grade).toLowerCase() === String(grade).toLowerCase());
    const payload = {
      grade,
      goalGolden: Number(goalGolden),
      rewardText,
      timestamp: new Date().toISOString()
    };
    if (existing) {
      await db.updateRow('GradeGoals', ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'], existing._rowNum, payload);
    } else {
      await db.appendRow('GradeGoals', ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'], payload);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save grade goal' });
  }
});

// --- Point Spending Store CRUD ---
app.post('/api/spending', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const { recipient, amount, item } = req.body;
  const amt = Math.floor(Number(amount));
  if (!recipient || !amt || amt < 1) {
    return res.status(400).json({ message: 'Recipient name and a valid positive amount are required.' });
  }

  try {
    // Validate student balance
    const tickets = await db.getRows('Tickets');
    const spending = await db.getRows('Spending');

    const earned = tickets.filter(t => t.recipient === recipient && t.recipientType === 'student').length;
    const spent = spending.filter(s => s.recipient === recipient).reduce((sum, s) => sum + Number(s.amount || 0), 0);
    const available = earned - spent;

    if (amt > available) {
      return res.status(400).json({ message: `${recipient} only has ${available} ticket(s) remaining.` });
    }

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const newSpend = {
      id,
      teacherEmail: req.user.email,
      teacherName: req.user.name,
      recipient,
      amount: amt,
      item: item || '',
      timestamp
    };

    await db.appendRow('Spending', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'Amount', 'Item', 'Timestamp'], newSpend);
    res.json(newSpend);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error logging purchase' });
  }
});

app.delete('/api/spending/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const spendId = req.params.id;

  try {
    const spending = await db.getRows('Spending');
    const spend = spending.find(s => s.id === spendId);
    if (!spend) return res.status(404).json({ message: 'Spending record not found' });

    if (req.user.role !== 'admin' && spend.teacherEmail !== req.user.email) {
      return res.status(403).json({ message: 'You can only delete items you created' });
    }

    await db.deleteRow('Spending', spend._rowNum);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error deleting spending record' });
  }
});

// --- Admin Spending Reports API (Across School, Grade Level, and Teacher) ---
app.get('/api/reports/spending', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required for spending reports' });
  }

  try {
    const sheetsData = await db.getMultipleSheets(['Students', 'Spending', 'Users']);
    const students = sheetsData.Students || [];
    const spending = sheetsData.Spending || [];
    const profiles = sheetsData.Users || [];

    // Map student info by name
    const studentMap = new Map();
    students.forEach(s => {
      if (s.name) studentMap.set(s.name.trim().toLowerCase(), s);
    });

    // Enriched transactions
    const enrichedTransactions = spending.map(s => {
      const student = studentMap.get((s.recipient || '').trim().toLowerCase());
      return {
        id: s.id,
        recipient: s.recipient,
        studentId: student ? student.id : '',
        grade: student ? (student.grade || 'Unassigned') : 'Unassigned',
        homeroom: student ? (student.homeroom || 'Unassigned') : 'Unassigned',
        amount: Number(s.amount || 0),
        item: s.item || 'Reward Item',
        teacherEmail: s.teacherEmail || '',
        teacherName: s.teacherName || 'Staff Member',
        timestamp: s.timestamp
      };
    });

    // School Summary
    const totalSpent = enrichedTransactions.reduce((acc, t) => acc + t.amount, 0);
    const totalTransactions = enrichedTransactions.length;
    const uniqueSpenders = new Set(enrichedTransactions.map(t => (t.recipient || '').toLowerCase()).filter(Boolean)).size;
    const totalStudents = students.length;
    const avgSpentPerStudent = totalStudents > 0 ? (totalSpent / totalStudents) : 0;
    const avgSpentPerSpender = uniqueSpenders > 0 ? (totalSpent / uniqueSpenders) : 0;

    // Item popularity
    const itemCounts = {};
    enrichedTransactions.forEach(t => {
      const itm = (t.item || 'Reward Item').trim();
      itemCounts[itm] = (itemCounts[itm] || 0) + t.amount;
    });
    const topRewards = Object.entries(itemCounts)
      .map(([item, total]) => ({ item, total }))
      .sort((a, b) => b.total - a.total);

    // Breakdown by Grade Level
    const gradeMap = new Map();
    students.forEach(s => {
      const g = s.grade || 'Unassigned';
      if (!gradeMap.has(g)) {
        gradeMap.set(g, { grade: g, studentCount: 0, spenders: new Set(), totalSpent: 0, transactions: 0, itemCounts: {} });
      }
      gradeMap.get(g).studentCount++;
    });

    enrichedTransactions.forEach(t => {
      const g = t.grade || 'Unassigned';
      if (!gradeMap.has(g)) {
        gradeMap.set(g, { grade: g, studentCount: 0, spenders: new Set(), totalSpent: 0, transactions: 0, itemCounts: {} });
      }
      const grp = gradeMap.get(g);
      grp.totalSpent += t.amount;
      grp.transactions++;
      if (t.recipient) grp.spenders.add(t.recipient.toLowerCase());
      grp.itemCounts[t.item] = (grp.itemCounts[t.item] || 0) + t.amount;
    });

    const gradesReport = Array.from(gradeMap.values()).map(g => {
      const uniqueCount = g.spenders.size;
      const topItem = Object.entries(g.itemCounts).sort((a, b) => b[1] - a[1])[0];
      return {
        grade: g.grade,
        studentCount: g.studentCount,
        uniqueSpenders: uniqueCount,
        totalSpent: g.totalSpent,
        transactions: g.transactions,
        avgPerStudent: g.studentCount > 0 ? (g.totalSpent / g.studentCount) : 0,
        avgPerSpender: uniqueCount > 0 ? (g.totalSpent / uniqueCount) : 0,
        topReward: topItem ? topItem[0] : 'None'
      };
    }).sort((a, b) => a.grade.localeCompare(b.grade));

    // Breakdown by Homeroom Teacher / Classroom
    const homeroomMap = new Map();
    students.forEach(s => {
      const h = s.homeroom || 'Unassigned';
      if (!homeroomMap.has(h)) {
        homeroomMap.set(h, { homeroom: h, grade: s.grade || 'Unassigned', studentCount: 0, spenders: new Set(), totalSpent: 0, transactions: 0, itemCounts: {} });
      }
      homeroomMap.get(h).studentCount++;
    });

    enrichedTransactions.forEach(t => {
      const h = t.homeroom || 'Unassigned';
      if (!homeroomMap.has(h)) {
        homeroomMap.set(h, { homeroom: h, grade: t.grade || 'Unassigned', studentCount: 0, spenders: new Set(), totalSpent: 0, transactions: 0, itemCounts: {} });
      }
      const hr = homeroomMap.get(h);
      hr.totalSpent += t.amount;
      hr.transactions++;
      if (t.recipient) hr.spenders.add(t.recipient.toLowerCase());
      hr.itemCounts[t.item] = (hr.itemCounts[t.item] || 0) + t.amount;
    });

    const homeroomsReport = Array.from(homeroomMap.values()).map(h => {
      const uniqueCount = h.spenders.size;
      const topItem = Object.entries(h.itemCounts).sort((a, b) => b[1] - a[1])[0];
      return {
        homeroom: h.homeroom,
        grade: h.grade,
        studentCount: h.studentCount,
        uniqueSpenders: uniqueCount,
        totalSpent: h.totalSpent,
        transactions: h.transactions,
        avgPerStudent: h.studentCount > 0 ? (h.totalSpent / h.studentCount) : 0,
        avgPerSpender: uniqueCount > 0 ? (h.totalSpent / uniqueCount) : 0,
        topReward: topItem ? topItem[0] : 'None'
      };
    }).sort((a, b) => a.homeroom.localeCompare(b.homeroom));

    // Breakdown by Facilitating / Store Staff
    const staffMap = new Map();
    enrichedTransactions.forEach(t => {
      const key = (t.teacherEmail || t.teacherName || 'Unknown').trim().toLowerCase();
      if (!staffMap.has(key)) {
        staffMap.set(key, {
          teacherName: t.teacherName || 'Staff Member',
          teacherEmail: t.teacherEmail || '',
          totalSpent: 0,
          transactions: 0,
          studentsServed: new Set(),
          itemCounts: {}
        });
      }
      const st = staffMap.get(key);
      st.totalSpent += t.amount;
      st.transactions++;
      if (t.recipient) st.studentsServed.add(t.recipient.toLowerCase());
      st.itemCounts[t.item] = (st.itemCounts[t.item] || 0) + t.amount;
    });

    const staffReport = Array.from(staffMap.values()).map(s => {
      const topItem = Object.entries(s.itemCounts).sort((a, b) => b[1] - a[1])[0];
      return {
        teacherName: s.teacherName,
        teacherEmail: s.teacherEmail,
        totalSpent: s.totalSpent,
        transactions: s.transactions,
        uniqueStudentsServed: s.studentsServed.size,
        topReward: topItem ? topItem[0] : 'None'
      };
    }).sort((a, b) => b.totalSpent - a.totalSpent);

    // CSV format handling if requested
    if (req.query.format === 'csv') {
      const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
      const dateStr = new Date().toISOString().split('T')[0];

      let csv = `ROLLING RIDGE ELEMENTARY - PBIS GREEN TICKET SPENDING REPORT\n`;
      csv += `Generated Date: ${dateStr}\n`;
      csv += `Scope: School, Grade Level, and Teacher\n\n`;

      csv += `--- SECTION 1: SCHOOL-WIDE SPENDING SUMMARY ---\n`;
      csv += `Metric,Value\n`;
      csv += `Total Tickets Spent,${totalSpent}\n`;
      csv += `Total Transactions,${totalTransactions}\n`;
      csv += `Active Spending Students,${uniqueSpenders}\n`;
      csv += `Total Enrolled Students,${totalStudents}\n`;
      csv += `Average Spent Per Enrolled Student,${avgSpentPerStudent.toFixed(2)}\n`;
      csv += `Average Spent Per Active Spender,${avgSpentPerSpender.toFixed(2)}\n`;
      csv += `Top Reward Item,${escapeCsv(topRewards[0] ? `${topRewards[0].item} (${topRewards[0].total} tickets)` : 'None')}\n\n`;

      csv += `--- SECTION 2: SPENDING BY GRADE LEVEL ---\n`;
      csv += `Grade Level,Total Tickets Spent,Transactions,Active Spenders,Total Students,Avg Spent / Student,Top Reward\n`;
      gradesReport.forEach(g => {
        csv += `${escapeCsv(g.grade)},${g.totalSpent},${g.transactions},${g.uniqueSpenders},${g.studentCount},${g.avgPerStudent.toFixed(2)},${escapeCsv(g.topReward)}\n`;
      });
      csv += `\n`;

      csv += `--- SECTION 3: SPENDING BY HOMEROOM CLASSROOM (STUDENT'S TEACHER) ---\n`;
      csv += `Homeroom,Grade,Total Tickets Spent,Transactions,Active Spenders,Total Students,Avg Spent / Student,Top Reward\n`;
      homeroomsReport.forEach(h => {
        csv += `${escapeCsv(h.homeroom)},${escapeCsv(h.grade)},${h.totalSpent},${h.transactions},${h.uniqueSpenders},${h.studentCount},${h.avgPerStudent.toFixed(2)},${escapeCsv(h.topReward)}\n`;
      });
      csv += `\n`;

      csv += `--- SECTION 4: SPENDING BY FACILITATING TEACHER (STORE STAFF) ---\n`;
      csv += `Teacher Name,Teacher Email,Total Tickets Redeemed,Transactions,Students Served,Top Reward\n`;
      staffReport.forEach(s => {
        csv += `${escapeCsv(s.teacherName)},${escapeCsv(s.teacherEmail)},${s.totalSpent},${s.transactions},${s.uniqueStudentsServed},${escapeCsv(s.topReward)}\n`;
      });
      csv += `\n`;

      csv += `--- SECTION 5: DETAILED ITEMISED SPENDING TRANSACTIONS ---\n`;
      csv += `Date,Time,Student Name,Student ID,Grade,Homeroom,Reward Item,Tickets Spent,Logged By Teacher,Teacher Email,Transaction ID\n`;
      enrichedTransactions.forEach(t => {
        const d = t.timestamp ? new Date(t.timestamp) : new Date();
        const dStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString();
        const tStr = isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
        csv += `${escapeCsv(dStr)},${escapeCsv(tStr)},${escapeCsv(t.recipient)},${escapeCsv(t.studentId)},${escapeCsv(t.grade)},${escapeCsv(t.homeroom)},${escapeCsv(t.item)},${t.amount},${escapeCsv(t.teacherName)},${escapeCsv(t.teacherEmail)},${escapeCsv(t.id)}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="RRD_PBIS_Spending_Report_${dateStr}.csv"`);
      return res.send(csv);
    }

    res.json({
      school: {
        totalSpent,
        totalTransactions,
        uniqueSpenders,
        totalStudents,
        avgSpentPerStudent,
        avgSpentPerSpender,
        topRewards: topRewards.slice(0, 10)
      },
      grades: gradesReport,
      homerooms: homeroomsReport,
      staff: staffReport,
      transactions: enrichedTransactions
    });
  } catch (err) {
    console.error("Error generating spending report:", err);
    res.status(500).json({ message: 'Failed to generate spending report' });
  }
});

// --- Class Goals Configuration ---
app.post('/api/class-goals', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const { className, goalTickets, rewardText } = req.body;
  if (!className || goalTickets === undefined || !rewardText) {
    return res.status(400).json({ message: 'Class name, goal tickets, and reward text are required' });
  }

  try {
    const goals = await db.getRows('ClassGoals');
    const existing = goals.find(g => g.className === className);
    const timestamp = new Date().toISOString();
    const goalData = { className, goalTickets: Number(goalTickets), rewardText, timestamp };

    if (existing) {
      await db.updateRow('ClassGoals', ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'], existing._rowNum, goalData);
    } else {
      await db.appendRow('ClassGoals', ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'], goalData);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error saving class goal' });
  }
});

// --- Grade Level Goals ---
app.post('/api/grade-goals', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  const { grade, goalGolden, rewardText } = req.body;
  if (!grade || goalGolden === undefined || !rewardText) {
    return res.status(400).json({ message: 'Grade, goal golden, and reward text are required' });
  }

  try {
    const goals = await db.getRows('GradeGoals');
    const existing = goals.find(g => g.grade === grade);
    const timestamp = new Date().toISOString();
    const goalData = { grade, goalGolden: Number(goalGolden), rewardText, timestamp };

    if (existing) {
      await db.updateRow('GradeGoals', ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'], existing._rowNum, goalData);
    } else {
      await db.appendRow('GradeGoals', ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'], goalData);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error saving grade goal' });
  }
});

// --- Raffle Helper & CRUD Endpoints ---
function matchHomeroomName(studentHomeroom, targetHomeroom) {
  if (!studentHomeroom || !targetHomeroom) return false;
  const s = studentHomeroom.trim().toLowerCase();
  const t = targetHomeroom.trim().toLowerCase();
  if (s === t) return true;
  if (s.includes(t) || t.includes(s)) return true;
  const getLastNameOnly = (name) => {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0];
  };
  const sLast = getLastNameOnly(studentHomeroom).toLowerCase();
  const tLast = getLastNameOnly(targetHomeroom).toLowerCase();
  if (sLast && tLast && sLast === tLast && sLast.length > 2) return true;
  return false;
}

// Record Raffle Winner
app.post('/api/raffle/winners', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });

  const { winnerName, winnerType = 'student', homeroom = '', grade = '', ticketCount = 1, scope = 'class' } = req.body;
  if (!winnerName) {
    return res.status(400).json({ message: 'Winner name is required' });
  }

  const isAdmin = req.user.role === 'admin';

  // 1. Only admins can run teacher raffles
  if (winnerType === 'teacher' && !isAdmin) {
    return res.status(403).json({ message: 'Only administrators can run teacher raffles.' });
  }

  // 2. Only admins can run whole-school raffles
  const isWholeSchool = scope === 'all' || (typeof scope === 'string' && (scope.toLowerCase().includes('whole school') || scope.toLowerCase().includes('all homerooms')));
  if (isWholeSchool && !isAdmin) {
    return res.status(403).json({ message: 'Only administrators can run school-wide raffles.' });
  }

  // 3. For homeroom teachers, verify the draw is for their assigned or co-taught class
  if (!isAdmin) {
    const users = await db.getRows('Users');
    const userProfile = users.find(u => (u.email || '').trim().toLowerCase() === (req.user.email || '').trim().toLowerCase());
    let coTaught = [];
    if (userProfile && userProfile.coTaughtHomerooms) {
      try { coTaught = JSON.parse(userProfile.coTaughtHomerooms); } catch (e) {
        coTaught = typeof userProfile.coTaughtHomerooms === 'string' ? userProfile.coTaughtHomerooms.split(',').map(s => s.trim()) : [];
      }
    }
    const allowedClasses = [req.user.name, ...(userProfile ? [userProfile.name] : []), ...coTaught].filter(Boolean);
    const targetClass = homeroom || scope;
    const isAllowed = allowedClasses.some(c => matchHomeroomName(targetClass, c));

    if (!isAllowed) {
      return res.status(403).json({ message: 'Homeroom teachers can only run raffles for their own assigned homeroom or co-taught classes.' });
    }
  }

  try {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const newRecord = {
      id,
      winnerName: winnerName.trim(),
      winnerType: winnerType || 'student',
      homeroom: (homeroom || '').trim(),
      grade: (grade || '').trim(),
      ticketCount: Math.max(1, Math.floor(Number(ticketCount) || 1)),
      drawnByEmail: req.user.email,
      drawnByName: req.user.name,
      scope: (scope || homeroom || 'class').trim(),
      timestamp
    };

    await db.appendRow('RaffleWinners', ['Id', 'WinnerName', 'WinnerType', 'Homeroom', 'Grade', 'TicketCount', 'DrawnByEmail', 'DrawnByName', 'Scope', 'Timestamp'], newRecord);
    res.json(newRecord);
  } catch (err) {
    console.error("Error recording raffle winner:", err);
    res.status(500).json({ message: 'Failed to record raffle winner' });
  }
});

// Delete Raffle Winner record (Admin or original drawer)
app.delete('/api/raffle/winners/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const winnerId = req.params.id;

  try {
    const records = await db.getRows('RaffleWinners');
    const record = records.find(r => r.id === winnerId);
    if (!record) return res.status(404).json({ message: 'Raffle winner record not found' });

    if (req.user.role !== 'admin' && (record.drawnByEmail || '').toLowerCase() !== (req.user.email || '').toLowerCase()) {
      return res.status(403).json({ message: 'You can only delete raffle entries you created.' });
    }

    await db.deleteRow('RaffleWinners', record._rowNum);
    res.json({ success: true, message: 'Raffle winner record deleted.' });
  } catch (err) {
    console.error("Error deleting raffle winner record:", err);
    res.status(500).json({ message: 'Failed to delete raffle winner record' });
  }
});

// Clear all raffle history (Admin only)
app.post('/api/raffle/clear', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
  try {
    await db.clearSheet('RaffleWinners');
    res.json({ success: true, message: 'All raffle history has been reset.' });
  } catch (err) {
    console.error("Error clearing raffle history:", err);
    res.status(500).json({ message: 'Failed to clear raffle history' });
  }
});

// --- Roster Management APIs ---

// Roster Upload (Admin only)
app.post('/api/roster/upload', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  const { csvText, students } = req.body;

  try {
    let parsedRows = [];
    if (students && Array.isArray(students)) {
      parsedRows = students;
    } else {
      if (!csvText) return res.status(400).json({ message: 'CSV text or students array is required' });
      const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const line of lines) {
        const parts = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            parts.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        parts.push(current.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) {
          return res.status(400).json({ message: 'Invalid roster upload format. Each student must have a name and homeroom.' });
        }
        parsedRows.push({
          name: parts[0],
          homeroom: parts[1],
          grade: parts[2] || 'N/A'
        });
      }
    }

    const studentsSheet = await db.getRows('Students');
    const normalizeName = (name) => (name || '').trim().replace(/\s+/g, ' ').toLowerCase();

    // Map existing students by normalized name (deduplicating any pre-existing duplicates in DB)
    const existingStudentsMap = new Map();
    const allStudentsMap = new Map();
    const usedIds = new Set();

    for (const s of studentsSheet) {
      if (s.id) usedIds.add(String(s.id).trim());
      const norm = normalizeName(s.name);
      if (norm && !allStudentsMap.has(norm)) {
        allStudentsMap.set(norm, { ...s });
        existingStudentsMap.set(norm, { ...s });
      }
    }

    // Helper: generate next available short numeric student ID (e.g. 1001, 1002...)
    let currentIdCounter = 1001;
    const generateNumericId = () => {
      while (usedIds.has(String(currentIdCounter))) {
        currentIdCounter++;
      }
      const idStr = String(currentIdCounter);
      usedIds.add(idStr);
      return idStr;
    };

    let createdCount = 0;
    let updatedCount = 0;
    let movedCount = 0;
    const processedInThisImport = new Set();

    for (const raw of parsedRows) {
      const cleanName = (raw.name || '').trim().replace(/\s+/g, ' ');
      const cleanHomeroom = (raw.homeroom || '').trim();
      const cleanGrade = (raw.grade || 'N/A').trim();
      const norm = normalizeName(cleanName);

      if (!norm || !cleanHomeroom) continue;

      if (allStudentsMap.has(norm)) {
        // Student already exists (either in DB or encountered earlier in this import)
        const existingRec = allStudentsMap.get(norm);
        const wasInDb = existingStudentsMap.has(norm);
        const homeroomChanged = existingRec.homeroom !== cleanHomeroom;
        const gradeChanged = existingRec.grade !== cleanGrade;

        if (homeroomChanged || gradeChanged) {
          if (homeroomChanged) movedCount++;
          existingRec.homeroom = cleanHomeroom;
          existingRec.grade = cleanGrade;
          if (wasInDb && !processedInThisImport.has(norm)) {
            updatedCount++;
          }
        }
        existingRec.name = cleanName; // Ensure clean casing
        processedInThisImport.add(norm);
      } else {
        // Genuinely new student account
        const pinCode = Math.floor(1000 + Math.random() * 9000).toString();
        const studentId = generateNumericId();

        const newStudent = {
          id: studentId,
          name: cleanName,
          homeroom: cleanHomeroom,
          grade: cleanGrade,
          pinCode
        };

        allStudentsMap.set(norm, newStudent);
        processedInThisImport.add(norm);
        createdCount++;
      }
    }

    const finalStudentsList = Array.from(allStudentsMap.values());
    await db.setAllRows('Students', ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'], finalStudentsList);

    res.json({
      success: true,
      totalRosterCount: finalStudentsList.length,
      importedCount: processedInThisImport.size,
      createdCount,
      updatedCount,
      movedCount,
      students: finalStudentsList
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error uploading student roster' });
  }
});

// Add individual student
app.post('/api/students', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const { name, homeroom, grade } = req.body;
  if (!name || !homeroom || !grade) {
    return res.status(400).json({ message: 'Name, homeroom, and grade are required.' });
  }

  try {
    const studentsSheet = await db.getRows('Students');
    const cleanName = name.trim().replace(/\s+/g, ' ');
    const cleanHomeroom = homeroom.trim();
    const cleanGrade = grade.trim();
    const norm = cleanName.toLowerCase();

    const existing = studentsSheet.find(s => (s.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === norm);
    if (existing) {
      // If student already exists, move them to the requested teacher's class/grade
      // Do not create a new duplicate student account
      existing.homeroom = cleanHomeroom;
      existing.grade = cleanGrade;
      existing.name = cleanName;
      await db.updateRow('Students', ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'], existing._rowNum, existing);
      return res.json(existing);
    }

    const pinCode = Math.floor(1000 + Math.random() * 9000).toString();
    // Generate next available short numeric student ID (e.g. 1001, 1002...)
    const allExistingIds = new Set(studentsSheet.map(s => String(s.id).trim()).filter(Boolean));
    let numId = 1001;
    while (allExistingIds.has(String(numId))) numId++;
    const studentId = String(numId);

    const newStudent = {
      id: studentId,
      name: cleanName,
      homeroom: cleanHomeroom,
      grade: cleanGrade,
      pinCode
    };

    await db.appendRow('Students', ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'], newStudent);
    res.json(newStudent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add student to roster' });
  }
});

// Clear Roster (Admin only)
app.post('/api/roster/clear', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  try {
    await db.clearSheet('Students');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to clear student list' });
  }
});

// Merge duplicate students (Admin only)
app.post('/api/roster/merge', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  const { sourceName, targetName } = req.body;
  if (!sourceName || !targetName) {
    return res.status(400).json({ message: 'Source name and target name are required' });
  }

  try {
    const sheetsData = await db.getMultipleSheets(['Students', 'Tickets', 'Spending']);
    const students = sheetsData.Students || [];
    const tickets = sheetsData.Tickets || [];
    const spending = sheetsData.Spending || [];

    const sourceStudent = students.find(s => s.name === sourceName);
    if (!sourceStudent) return res.status(404).json({ message: `Source student ${sourceName} not found` });
    const targetStudent = students.find(s => s.name === targetName);
    if (!targetStudent) return res.status(404).json({ message: `Target student ${targetName} not found` });

    // Transfer tickets
    const sourceTickets = tickets.filter(t => t.recipient === sourceName);
    for (const t of sourceTickets) {
      t.recipient = targetName;
      await db.updateRow('Tickets', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'], t._rowNum, t);
    }

    // Transfer spending
    const sourceSpending = spending.filter(s => s.recipient === sourceName);
    for (const s of sourceSpending) {
      s.recipient = targetName;
      await db.updateRow('Spending', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'Amount', 'Item', 'Timestamp'], s._rowNum, s);
    }

    // Delete duplicate student record
    await db.deleteRow('Students', sourceStudent._rowNum);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error merging student profiles' });
  }
});

// Delete teacher profile (Admin or account owner)
app.delete('/api/teachers/:email', authMiddleware, async (req, res) => {
  const emailToDelete = req.params.email;
  if (req.user.role !== 'admin' && req.user.email !== emailToDelete) {
    return res.status(403).json({ message: 'Admin access required to delete other teacher accounts' });
  }

  try {
    const users = await db.getRows('Users');
    const teacher = users.find(u => u.email.toLowerCase() === emailToDelete.toLowerCase());
    if (!teacher) return res.status(404).json({ message: 'Teacher profile not found' });

    await db.deleteRow('Users', teacher._rowNum);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete teacher account' });
  }
});

// Update individual student (Admin / Teacher only)
app.put('/api/students/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const oldId = req.params.id;
  const { id: newId, name, homeroom, grade, pinCode } = req.body;

  if (!name || !homeroom || !grade || !newId || !pinCode) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const studentsSheet = await db.getRows('Students');
    const studentIdx = studentsSheet.findIndex(s => s.id === oldId);
    if (studentIdx === -1) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    // Check if new student ID is taken by another student
    if (newId.toUpperCase() !== oldId.toUpperCase() && studentsSheet.some(s => s.id.toUpperCase() === newId.toUpperCase())) {
      return res.status(400).json({ message: `Student ID '${newId}' is already in use.` });
    }

    const updatedStudent = {
      id: newId.trim(),
      name: name.trim(),
      homeroom: homeroom.trim(),
      grade: grade.trim(),
      pinCode: pinCode.trim()
    };

    // If the name changed, update the tickets and spending sheets too!
    const oldName = studentsSheet[studentIdx].name;
    if (oldName !== updatedStudent.name) {
      // Best-effort cascade name updates
      const tickets = await db.getRows('Tickets');
      for (const t of tickets) {
        if (t.recipient === oldName && t.recipientType === 'student') {
          t.recipient = updatedStudent.name;
          await db.updateRow('Tickets', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'], t._rowNum, t);
        }
      }
      const spending = await db.getRows('Spending');
      for (const s of spending) {
        if (s.recipient === oldName) {
          s.recipient = updatedStudent.name;
          await db.updateRow('Spending', ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'Amount', 'Item', 'Timestamp'], s._rowNum, s);
        }
      }
    }

    await db.updateRow('Students', ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'], studentsSheet[studentIdx]._rowNum, updatedStudent);
    res.json(updatedStudent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update student' });
  }
});

// Delete / remove student from roster (Admin or Homeroom Teacher for their class)
app.delete('/api/students/:id', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
  const studentId = req.params.id;

  try {
    const studentsSheet = await db.getRows('Students');
    const student = studentsSheet.find(s => s.id === studentId);
    if (!student) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    // Permission check: Admins can remove any student.
    // Homeroom teachers can remove students from their own homeroom or co-taught classes.
    if (req.user.role !== 'admin') {
      const users = await db.getRows('Users');
      const userProfile = users.find(u => (u.email || '').trim().toLowerCase() === (req.user.email || '').trim().toLowerCase());
      let coTaught = [];
      if (userProfile && userProfile.coTaughtHomerooms) {
        try {
          coTaught = JSON.parse(userProfile.coTaughtHomerooms);
        } catch (e) {
          coTaught = typeof userProfile.coTaughtHomerooms === 'string' ? userProfile.coTaughtHomerooms.split(',').map(s => s.trim()) : [];
        }
      }
      const allowedClasses = [req.user.name, ...(userProfile ? [userProfile.name] : []), ...coTaught].filter(Boolean);
      const isAllowed = allowedClasses.some(c => matchHomeroomName(student.homeroom, c));

      if (!isAllowed) {
        return res.status(403).json({ message: 'Homeroom teachers can only remove students from their own assigned or co-taught homeroom.' });
      }
    }

    await db.deleteRow('Students', student._rowNum);
    res.json({ success: true, message: `Student ${student.name} removed from roster.` });
  } catch (err) {
    console.error("Error deleting student:", err);
    res.status(500).json({ message: 'Failed to remove student from roster.' });
  }
});


// Reset own password (Teacher / Admin)
app.post('/api/auth/reset-password', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Only teachers and admins can reset passwords' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current password and new password are required.' });
  }

  try {
    const users = await db.getRows('Users');
    const user = users.find(u => u.email.toLowerCase() === req.user.email.toLowerCase());
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({ message: 'Invalid current password.' });
    }

    user.password = hashPassword(newPassword);
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt', 'CoTaughtHomerooms'], user._rowNum, user);
    res.json({ message: 'Password updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error resetting password.' });
  }
});

// --- Frontend Assets Server ---
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('Server is running (Development API Mode)');
  });
}

// --- Start Server ---
async function start() {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  } catch (e) {
    console.error("Critical: Failed to initialize database connection:", e.message);
    process.exit(1);
  }
}

start();
