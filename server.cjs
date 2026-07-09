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
  }

  async init() {
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
      auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      console.log("Authenticated Google Sheets API using Application Default Credentials (ADC)");
    }

    this.sheets = google.sheets({ version: 'v4', auth });
    await this.ensureTables();
  }

  async ensureTables() {
    const requiredSheets = [
      { name: 'Users', headers: ['Email', 'Name', 'Role', 'Password', 'CreatedAt'] },
      { name: 'Students', headers: ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'] },
      { name: 'Tickets', headers: ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'RecipientType', 'Reason', 'Timestamp'] },
      { name: 'GoldenTickets', headers: ['Id', 'TeacherEmail', 'TeacherName', 'ClassName', 'Timestamp'] },
      { name: 'Spending', headers: ['Id', 'TeacherEmail', 'TeacherName', 'Recipient', 'Amount', 'Item', 'Timestamp'] },
      { name: 'ClassGoals', headers: ['ClassName', 'GoalTickets', 'RewardText', 'Timestamp'] },
      { name: 'GradeGoals', headers: ['Grade', 'GoalGolden', 'RewardText', 'Timestamp'] }
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
        } else {
          // Sheet exists, verify and update headers if columns are missing
          const rangeRes = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: `${req.name}!A1:Z1`
          });
          const currentHeaders = rangeRes.data.values ? rangeRes.data.values[0] : [];
          const missingHeader = req.headers.some(h => !currentHeaders.map(x => x.trim().toLowerCase()).includes(h.toLowerCase()));
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
      console.error("Error communicating with Google Sheets:", e.message);
      console.error("Make sure your Sheet is shared with the service account and SPREADSHEET_ID is correct.");
    }
  }

  async getRows(sheetName) {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:Z`
      });
      const rows = res.data.values;
      if (!rows || rows.length < 2) return [];
      const headers = rows[0].map(h => h.trim());
      return rows.slice(1).map((row, rowIndex) => {
        const obj = { _rowNum: rowIndex + 2 }; // 1-based index (row 2 is data index 0)
        headers.forEach((h, index) => {
          const key = h.charAt(0).toLowerCase() + h.slice(1);
          obj[key] = row[index] !== undefined ? row[index] : '';
        });
        return obj;
      });
    } catch (e) {
      console.error(`Error reading sheet ${sheetName}:`, e.message);
      return [];
    }
  }

  async appendRow(sheetName, headers, rowObj) {
    try {
      const values = headers.map(h => {
        const key = h.charAt(0).toLowerCase() + h.slice(1);
        return rowObj[key] !== undefined ? rowObj[key] : '';
      });
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });
    } catch (e) {
      console.error(`Error appending to sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async updateRow(sheetName, headers, rowNum, rowObj) {
    try {
      const values = headers.map(h => {
        const key = h.charAt(0).toLowerCase() + h.slice(1);
        return rowObj[key] !== undefined ? rowObj[key] : '';
      });
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] }
      });
    } catch (e) {
      console.error(`Error updating row ${rowNum} in sheet ${sheetName}:`, e.message);
      throw e;
    }
  }

  async deleteRow(sheetName, rowNum) {
    try {
      const ssMeta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const sheet = ssMeta.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) throw new Error(`Sheet worksheet ${sheetName} not found`);
      const sheetId = sheet.properties.sheetId;

      await this.sheets.spreadsheets.batchUpdate({
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
      });
    } catch (e) {
      console.error(`Error deleting row ${rowNum} in sheet ${sheetName}:`, e.message);
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
    
    // Auto-onboard first user as admin if Users is empty
    if (users.length === 0) {
      const hashedPassword = hashPassword(password);
      const newUser = {
        email: email.trim().toLowerCase(),
        name: email.split('@')[0],
        role: 'admin',
        password: hashedPassword,
        createdAt: new Date().toISOString()
      };
      await db.appendRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt'], newUser);
      
      const token = jwt.sign({ email: newUser.email, role: newUser.role, name: newUser.name }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, profile: { email: newUser.email, name: newUser.name, role: newUser.role } });
    }

    const user = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, profile: { email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during authentication' });
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
    const existing = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (existing) {
      return res.status(400).json({ message: 'A teacher with this email already exists' });
    }

    const hashedPassword = hashPassword(password);
    const newUser = {
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: role.trim(),
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };
    await db.appendRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt'], newUser);
    res.json({ message: 'Registration successful! You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error during registration' });
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
    await db.updateRow('Users', ['Email', 'Name', 'Role', 'Password', 'CreatedAt'], user._rowNum, user);

    // Issue a new JWT with the updated role
    const token = jwt.sign({ email: user.email, role: newRole, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, profile: { email: user.email, name: user.name, role: newRole } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error changing role.' });
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
      const allStudents = await db.getRows('Students');
      const student = allStudents.find(s => s.id === studentId);
      if (!student) return res.status(404).json({ message: 'Student profile not found' });

      const allTickets = await db.getRows('Tickets');
      const studentTickets = allTickets.filter(t => t.recipient === student.name && t.recipientType === 'student');

      const allSpending = await db.getRows('Spending');
      const studentSpending = allSpending.filter(s => s.recipient === student.name);

      const classGoals = await db.getRows('ClassGoals');
      const classGoal = classGoals.find(g => g.className === student.homeroom) || null;

      const gradeGoals = await db.getRows('GradeGoals');
      const gradeGoal = gradeGoals.find(g => g.grade === student.grade) || null;

      const earned = studentTickets.length;
      const spent = studentSpending.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      const balance = earned - spent;

            const allGolden = await db.getRows('GoldenTickets');
      const goldenTickets = allGolden.filter(g => g.className === student.homeroom);

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
    const email = req.user.email;
    const profiles = await db.getRows('Users');
    const profile = profiles.find(p => p.email === email);
    if (!profile) return res.status(404).json({ message: 'Teacher profile not found' });

    delete profile.password; // remove sensitive field

    const students = await db.getRows('Students');
    const goldenTickets = await db.getRows('GoldenTickets');
    const classGoals = await db.getRows('ClassGoals');
    const gradeGoals = await db.getRows('GradeGoals');

    let tickets = await db.getRows('Tickets');
    let spending = await db.getRows('Spending');

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

    // Visibility rules: Specialists and Homerooms see only tickets/spending they created
    // Admins see all tickets/spending
    if (profile.role !== 'admin') {
      tickets = tickets.filter(t => t.teacherEmail === email);
      spending = spending.filter(s => s.teacherEmail === email);
    }

    const sanitizedProfiles = profiles.map(p => {
      const copy = { ...p };
      delete copy.password;
      return copy;
    });

    res.json({
      role: profile.role,
      profile,
      profiles: sanitizedProfiles,
      students,
      tickets,
      goldenTickets,
      spending,
      classGoals,
      gradeGoals,
      balances
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to retrieve initial data' });
  }
});

// --- Behavior Tickets CRUD ---
app.post('/api/tickets', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ message: 'Unauthorized' });
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

// --- Roster Management APIs ---

// Roster Upload (Admin only)
app.post('/api/roster/upload', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  const { csvText } = req.body;
  if (!csvText) return res.status(400).json({ message: 'CSV text is required' });

  try {
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const uploaded = [];
    const studentsSheet = await db.getRows('Students');

    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
        return res.status(400).json({ message: 'Invalid roster upload format. Each student must have a name, homeroom, and grade.' });
      }
      const name = parts[0];
      const homeroom = parts[1];
      const grade = parts[2];

      const pinCode = Math.floor(1000 + Math.random() * 9000).toString();

      // Generate a Student ID format: LASTNAME-FIRSTNAME or FIRSTNAME-LASTNAME (sanitized uppercase)
      let baseId = name.toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-');
      if (baseId.startsWith('-')) baseId = baseId.slice(1);
      if (baseId.endsWith('-')) baseId = baseId.slice(0, -1);

      let studentId = baseId;
      let counter = 1;
      const idExists = (id) => studentsSheet.some(s => s.id === id) || uploaded.some(s => s.id === id);
      while (idExists(studentId)) {
        studentId = `${baseId}-${counter}`;
        counter++;
      }

      const newStudent = {
        id: studentId,
        name,
        homeroom,
        grade,
        pinCode
      };

      await db.appendRow('Students', ['Id', 'Name', 'Homeroom', 'Grade', 'PinCode'], newStudent);
      uploaded.push(newStudent);
    }

    res.json(uploaded);
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
    const exists = studentsSheet.some(s => s.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (exists) {
      return res.status(400).json({ message: `Student '${name}' already exists in the roster.` });
    }

    const pinCode = Math.floor(1000 + Math.random() * 9000).toString();
    let baseId = name.toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-');
    if (baseId.startsWith('-')) baseId = baseId.slice(1);
    if (baseId.endsWith('-')) baseId = baseId.slice(0, -1);

    let studentId = baseId;
    let counter = 1;
    while (studentsSheet.some(s => s.id === studentId)) {
      studentId = `${baseId}-${counter}`;
      counter++;
    }

    const newStudent = {
      id: studentId,
      name: name.trim(),
      homeroom: homeroom.trim(),
      grade: grade.trim(),
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
    await db.sheets.spreadsheets.values.clear({
      spreadsheetId: db.spreadsheetId,
      range: 'Students!A2:Z'
    });
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
    const students = await db.getRows('Students');
    const tickets = await db.getRows('Tickets');
    const spending = await db.getRows('Spending');

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
