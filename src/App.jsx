import React, { useState, useEffect, useMemo } from 'react';
import {
  Ticket, Users, Shield, Palette, Download, LogOut,
  Award, PieChart, ChevronLeft, CheckCircle2, X, AlertTriangle, Trash2, Star, Search,
  Crown, BarChart3, TrendingUp, GitMerge, ArrowRight
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAnalytics } from 'firebase/analytics';
import { getAuth, signInAnonymously, signOut, onAuthStateChanged } from 'firebase/auth';
import {
  initializeFirestore, getFirestore, persistentLocalCache,
  collection, doc, setDoc, onSnapshot,
  addDoc, serverTimestamp, writeBatch, deleteDoc, query, where, getDocs
} from 'firebase/firestore';

// --- Firebase Setup ---
const firebaseConfig = {
  apiKey: "AIzaSyDFaghCP9SYQcUwRAYmzFWQfRNr14KNacQ",
  authDomain: "school-experiments-5bc99.firebaseapp.com",
  projectId: "school-experiments-5bc99",
  storageBucket: "school-experiments-5bc99.firebasestorage.app",
  messagingSenderId: "413467320532",
  appId: "1:413467320532:web:bb4c813435161776b49b41",
  measurementId: "G-6VT532QW0M"
};

const appId = 'school-green-ticket-react';
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({}) });
} catch (e) {
  console.warn("Offline persistence not available, using default Firestore:", e);
  db = getFirestore(app);
}

// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [effectiveUid, setEffectiveUid] = useState(null); // primary UID for linked devices
  const [loading, setLoading] = useState(true);

  // Data State
  const [tickets, setTickets] = useState([]);
  const [students, setStudents] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [goldenTickets, setGoldenTickets] = useState([]);

  // UI State
  const [toast, setToast] = useState({ visible: false, message: '' });
  const uid = user?.uid;

  // 1. Initialize Auth
  useEffect(() => {
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (err) {
        console.error("Auth failed:", err);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. Fetch profile (Only after auth — depends on uid, not user object ref)
  useEffect(() => {
    if (!uid) return;

    // Listen to own profile doc only (1 read) instead of entire collection
    const myProfileRef = doc(db, 'artifacts', appId, 'public', 'data', 'users', uid);
    const unsubMyProfile = onSnapshot(myProfileRef, (docSnap) => {
      if (!docSnap.exists()) {
        setProfile(null);
        setEffectiveUid(null);
        // Only stop loading once server confirms doc doesn't exist
        // (cache may say "not found" before server has responded)
        if (docSnap.metadata.fromCache === false) setLoading(false);
        return;
      }
      const myDoc = { id: docSnap.id, ...docSnap.data() };
      if (myDoc.linkedTo) {
        setEffectiveUid(myDoc.linkedTo);
      } else {
        setProfile(myDoc);
        setEffectiveUid(uid);
      }
      // Profile exists — show the app immediately, even from cache
      setLoading(false);
    });

    // For linked devices, listen to the primary profile doc
    // This is set up dynamically when effectiveUid changes (see next effect)

    return () => { unsubMyProfile(); };
  }, [uid]);

  // 2b. If linked, listen to primary profile + fetch linked UIDs for myUids
  useEffect(() => {
    if (!effectiveUid || effectiveUid === uid) return;

    const primaryRef = doc(db, 'artifacts', appId, 'public', 'data', 'users', effectiveUid);
    const unsub = onSnapshot(primaryRef, (docSnap) => {
      if (docSnap.exists()) {
        setProfile({ id: docSnap.id, ...docSnap.data() });
      } else {
        console.warn("Linked primary profile not found:", effectiveUid);
        setProfile(null);
      }
    });
    return () => unsub();
  }, [effectiveUid, uid]);

  // 2c. Fetch profiles: linked UIDs for ticket filtering + all profiles for admin
  useEffect(() => {
    if (!effectiveUid || !profile) { setProfiles([]); return; }
    const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'users');
    if (profile.role === 'admin') {
      // Admin needs all profiles for the dashboard
      const unsub = onSnapshot(usersRef, (snap) => {
        setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });
      return () => unsub();
    } else {
      // Non-admin: one-time fetch of linked device UIDs only
      const q = query(usersRef, where('linkedTo', '==', effectiveUid));
      getDocs(q).then(snap => {
        setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }).catch(e => console.error("Error fetching linked profiles:", e));
    }
  }, [effectiveUid, profile?.role]);

  // 3. Fetch app data (tickets, students, goldenTickets) — only after profile is known
  useEffect(() => {
    if (!uid || !profile) return;

    const studentsRef = collection(db, 'artifacts', appId, 'public', 'data', 'students');
    const goldenRef = collection(db, 'artifacts', appId, 'public', 'data', 'goldenTickets');

    const unsubStudents = onSnapshot(studentsRef, (snap) => {
      setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubGolden = onSnapshot(goldenRef, (snap) => {
      setGoldenTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    // Scope tickets: admins see all, others see only their own
    const ticketsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tickets');
    let unsubTickets;
    if (profile.role === 'admin') {
      unsubTickets = onSnapshot(ticketsRef, (snap) => {
        setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });
    } else {
      // Only load this teacher's tickets (much fewer reads)
      const myTicketsQuery = query(ticketsRef, where('teacherId', '==', uid));
      unsubTickets = onSnapshot(myTicketsQuery, (snap) => {
        setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });
    }

    return () => { unsubStudents(); unsubGolden(); unsubTickets(); };
  }, [uid, profile?.role]);

  const showToast = (message) => {
    setToast({ visible: true, message });
    setTimeout(() => setToast({ visible: false, message: '' }), 3000);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 text-green-600">
        <Ticket className="w-12 h-12 animate-bounce mb-4" />
        <h2 className="text-xl font-bold text-gray-700">Loading Tracker...</h2>
      </div>
    );
  }

  if (!profile) {
    return <SetupProfile user={user} onComplete={() => showToast("Profile created!")} />;
  }

  // Collect all UIDs associated with this teacher (primary + all linked devices)
  // so ticket filtering shows tickets from any of the teacher's devices
  const myUids = new Set([effectiveUid]);
  profiles.forEach(p => {
    if (p.linkedTo === effectiveUid) myUids.add(p.id);
  });
  if (user) myUids.add(user.uid);

  const handleSignOut = async () => {
    // Clear all local state first so onSnapshot can't restore the old profile
    setProfile(null);
    setEffectiveUid(null);
    setTickets([]);
    setStudents([]);
    setProfiles([]);
    setGoldenTickets([]);
    try {
      // Sign out destroys the anonymous session, sign in creates a fresh one with a new UID
      await signOut(auth);
      await signInAnonymously(auth);
    } catch (e) {
      console.error("Error signing out:", e);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans text-gray-800">
      <Navbar profile={profile} tickets={tickets} onSignOut={handleSignOut} />

      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        {profile.role === 'admin' && (
          <AdminDashboard tickets={tickets} students={students} profiles={profiles} showToast={showToast} user={user} effectiveUid={effectiveUid} profile={profile} goldenTickets={goldenTickets} myUids={myUids} />
        )}
        {profile.role === 'homeroom' && (
          <HomeroomDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} effectiveUid={effectiveUid} goldenTickets={goldenTickets} myUids={myUids} />
        )}
        {profile.role === 'specialist' && (
          <SpecialistDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} effectiveUid={effectiveUid} goldenTickets={goldenTickets} myUids={myUids} />
        )}
      </main>

      {/* Toast Notification */}
      <div className={`fixed bottom-4 right-4 bg-gray-900 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 transition-all duration-300 ${toast.visible ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}>
        <CheckCircle2 className="w-5 h-5 text-green-400" />
        <span>{toast.message}</span>
      </div>
    </div>
  );
}

// --- Shared Helpers ---
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function TicketBreakdownBar({ tickets: ticketList }) {
  const counts = { Respectful: 0, Responsible: 0, Determined: 0 };
  ticketList.forEach(t => { if (counts[t.reason] !== undefined) counts[t.reason]++; });
  const total = ticketList.length;
  if (total === 0) return null;
  const segments = [
    { key: 'Respectful', count: counts.Respectful, color: 'bg-blue-500', label: 'Respectful' },
    { key: 'Responsible', count: counts.Responsible, color: 'bg-amber-500', label: 'Responsible' },
    { key: 'Determined', count: counts.Determined, color: 'bg-purple-500', label: 'Determined' },
  ];
  return (
    <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
      <h3 className="text-sm font-bold text-gray-700 mb-3">My Ticket Breakdown</h3>
      <div className="flex rounded-full overflow-hidden h-5 bg-gray-100 mb-3">
        {segments.map(s => s.count > 0 && (
          <div key={s.key} className={`${s.color} transition-all duration-500`} style={{ width: `${(s.count / total) * 100}%` }} title={`${s.label}: ${s.count}`} />
        ))}
      </div>
      <div className="flex justify-between text-xs font-semibold">
        {segments.map(s => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.color}`} />
            <span className="text-gray-600">{s.label}</span>
            <span className="text-gray-900">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getStudentReasonCounts(studentName, ticketList) {
  const counts = { Respectful: 0, Responsible: 0, Determined: 0 };
  ticketList.forEach(t => { if (t.recipient === studentName && counts[t.reason] !== undefined) counts[t.reason]++; });
  return counts;
}

function hasRecentTicket(studentName, ticketList) {
  const cutoff = Date.now() - ONE_WEEK_MS;
  return ticketList.some(t => t.recipient === studentName && t.timestamp && t.timestamp.toMillis() > cutoff);
}

function RecentTicketsList({ ticketList, onRemove, label }) {
  const sorted = [...ticketList].sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0)).slice(0, 10);
  if (sorted.length === 0) return null;
  return (
    <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
      <div className="px-5 py-3 border-b bg-gray-50 flex items-center justify-between">
        <h3 className="font-bold text-gray-800 text-sm">{label || 'My Recent Tickets'}</h3>
        <span className="text-xs text-gray-400">Tap trash to undo</span>
      </div>
      <div className="divide-y">
        {sorted.map(t => (
          <div key={t.id} className="flex items-center justify-between px-5 py-2.5 hover:bg-gray-50 transition">
            <div className="flex items-center gap-3 min-w-0">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${t.reason === 'Respectful' ? 'bg-blue-500' : t.reason === 'Responsible' ? 'bg-amber-500' : 'bg-purple-500'}`} />
              <span className="font-medium text-gray-800 text-sm truncate">{t.recipient}</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0 ${t.reason === 'Respectful' ? 'bg-blue-100 text-blue-700' : t.reason === 'Responsible' ? 'bg-amber-100 text-amber-700' : 'bg-purple-100 text-purple-700'}`}>{t.reason}</span>
              <span className="text-xs text-gray-400 flex-shrink-0">{t.timestamp ? t.timestamp.toDate().toLocaleDateString() : 'Now'}</span>
            </div>
            <button onClick={() => onRemove(t.id, t.recipient)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition flex-shrink-0 ml-2">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StudentSearch({ students, onSelect }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const allStudents = useMemo(() => {
    return [...new Set(students.map(s => s.name))].sort();
  }, [students]);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return allStudents.filter(name => name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, allStudents]);

  const getHomeroom = (name) => {
    const s = students.find(st => st.name === name);
    return s?.homeroom || 'Unknown';
  };

  const handleSelect = (name) => {
    onSelect({ recipient: name, type: 'student' });
    setQuery('');
    setFocused(false);
  };

  return (
    <div className="relative">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
        <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
          <Search className="w-4 h-4 text-gray-400" />
          Search Any Student
        </h3>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 200)}
            placeholder="Start typing a student name..."
            className="w-full border border-gray-300 rounded-lg p-3 pl-10 text-sm focus:ring-green-500 focus:border-green-500"
          />
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        </div>
        {focused && query.trim() && (
          <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-40 overflow-hidden mx-4">
            {results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-gray-400">No students found matching &quot;{query}&quot;</div>
            ) : (
              results.map(name => (
                <button key={name} onMouseDown={() => handleSelect(name)} className="w-full px-4 py-3 text-left hover:bg-green-50 transition flex items-center justify-between border-b last:border-b-0">
                  <span className="font-medium text-gray-800 text-sm">{name}</span>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{getHomeroom(name)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Student Ticket Card (Inline ticket giving) ---
function StudentTicketCard({ student, tickets: ticketList, onGiveTicket, isSubmitting, submittingFor }) {
  const rc = getStudentReasonCounts(student, ticketList);
  const noRecent = !hasRecentTicket(student, ticketList);
  const total = rc.Respectful + rc.Responsible + rc.Determined;
  const isBusy = isSubmitting && submittingFor === student;

  return (
    <div className={`p-3 rounded-xl shadow-sm border flex flex-col justify-between h-44 ${noRecent ? 'bg-red-50 border-red-300' : 'bg-white border-gray-200'}`}>
      <div className="flex items-start justify-between w-full mb-1">
        <span className={`font-bold leading-tight text-sm ${noRecent ? 'text-red-800' : 'text-gray-800'}`}>{student}</span>
        {noRecent && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 ml-1" />}
      </div>
      <div className="flex items-center justify-between text-xs mb-2">
        <span className="bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded">R {rc.Respectful}</span>
        <span className="bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5 rounded">S {rc.Responsible}</span>
        <span className="bg-purple-100 text-purple-700 font-bold px-1.5 py-0.5 rounded">D {rc.Determined}</span>
        <span className={`py-0.5 px-2 rounded-full font-black text-xs ${noRecent ? 'bg-red-100 text-red-700' : 'bg-green-50 text-green-700'}`}>{total}</span>
      </div>
      <div className="flex flex-col gap-1">
        <button disabled={isBusy} onClick={() => onGiveTicket(student, 'Respectful')}
          className="w-full py-1.5 bg-blue-50 hover:bg-blue-200 text-blue-700 rounded-lg font-bold text-xs border border-blue-200 hover:border-blue-400 transition disabled:opacity-50 disabled:cursor-not-allowed">
          {isBusy ? '...' : 'Respectful'}
        </button>
        <button disabled={isBusy} onClick={() => onGiveTicket(student, 'Responsible')}
          className="w-full py-1.5 bg-amber-50 hover:bg-amber-200 text-amber-700 rounded-lg font-bold text-xs border border-amber-200 hover:border-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed">
          {isBusy ? '...' : 'Responsible'}
        </button>
        <button disabled={isBusy} onClick={() => onGiveTicket(student, 'Determined')}
          className="w-full py-1.5 bg-purple-50 hover:bg-purple-200 text-purple-700 rounded-lg font-bold text-xs border border-purple-200 hover:border-purple-400 transition disabled:opacity-50 disabled:cursor-not-allowed">
          {isBusy ? '...' : 'Determined'}
        </button>
      </div>
    </div>
  );
}

// --- Components ---
function Navbar({ profile, tickets, onSignOut }) {
  const handleExport = () => {
    let data = profile.role === 'admin' ? tickets : tickets.filter(t => t.teacherId === profile.id);
    if (data.length === 0) return alert("No data to export.");
    let csv = "Date,Time,Teacher Name,Recipient,Recipient Type,Reason\n";
    data.sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0)).forEach(t => {
      const d = t.timestamp ? t.timestamp.toDate() : new Date();
      csv += `"${d.toLocaleDateString()}","${d.toLocaleTimeString()}","${t.teacherName}","${t.recipient}","${t.recipientType}","${t.reason}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Tickets_${profile.role}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  return (
    <nav className="bg-green-700 text-white shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ticket className="w-8 h-8 text-green-300" />
          <span className="font-bold text-xl tracking-tight">Green Tickets</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden sm:block text-sm font-medium bg-green-800 px-3 py-1 rounded-full">
            {profile.name} ({profile.role})
          </span>
          <button onClick={handleExport} className="flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium">
            <Download className="w-4 h-4" /> Export
          </button>
          <button onClick={onSignOut} className="flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium">
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </div>
    </nav>
  );
}

function SetupProfile({ user, onComplete }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('homeroom');
  const [adminPassword, setAdminPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [matchingTeachers, setMatchingTeachers] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (role === 'admin' && adminPassword !== 'data4life') {
      setPasswordError('Incorrect admin password.');
      return;
    }
    setPasswordError('');
    setError('');
    setIsSaving(true);
    try {
      // Check if a teacher with this name and role already exists
      const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'users');
      // Try case-insensitive match first (new profiles have nameNormalized)
      let q = query(usersRef, where('nameNormalized', '==', name.trim().toLowerCase()), where('role', '==', role));
      let snap = await getDocs(q);
      if (snap.empty) {
        // Fallback: exact name match for older profiles without nameNormalized
        q = query(usersRef, where('name', '==', name.trim()), where('role', '==', role));
        snap = await getDocs(q);
      }

      if (!snap.empty) {
        // Found existing teacher(s) — show picker for confirmation
        const matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setMatchingTeachers(matches);
        setIsSaving(false);
        return;
      }

      // No match — create a new profile
      await createNewProfile();
    } catch (err) {
      console.error("SetupProfile error:", err);
      setError('Something went wrong. Please check your connection and try again.');
    }
    setIsSaving(false);
  };

  const createNewProfile = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid), {
      name: name.trim(), nameNormalized: name.trim().toLowerCase(), role, customStudents: [], createdAt: serverTimestamp()
    });
    onComplete();
  };

  const linkToTeacher = async (primaryId) => {
    setIsSaving(true);
    setError('');
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid), {
        linkedTo: primaryId, createdAt: serverTimestamp()
      });
      onComplete();
    } catch (err) {
      console.error("Device linking error:", err);
      setError('Failed to link this device. Please try again.');
    }
    setIsSaving(false);
  };

  const handleCreateNewInstead = async () => {
    setMatchingTeachers(null);
    setIsSaving(true);
    setError('');
    try {
      await createNewProfile();
    } catch (err) {
      console.error("Profile creation error:", err);
      setError('Something went wrong. Please check your connection and try again.');
    }
    setIsSaving(false);
  };

  // Teacher picker view — shown when matching profiles are found
  if (matchingTeachers) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full">
          <div className="text-center mb-6">
            <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="w-8 h-8 text-blue-600" />
            </div>
            <h2 className="text-2xl font-bold">Link This Device</h2>
            <p className="text-gray-500 mt-1">We found an existing profile that matches. Is this you?</p>
          </div>
          <div className="space-y-3 mb-6">
            {matchingTeachers.map(t => (
              <button key={t.id} onClick={() => linkToTeacher(t.id)} disabled={isSaving}
                className="w-full p-4 border-2 border-green-200 rounded-xl hover:border-green-500 hover:bg-green-50 transition text-left disabled:opacity-50">
                <div className="font-bold text-gray-900">{t.name}</div>
                <div className="text-sm text-gray-500 capitalize">{t.role}</div>
                <div className="text-xs text-green-600 mt-1 font-semibold">Tap to link this device</div>
              </button>
            ))}
          </div>
          <button onClick={handleCreateNewInstead} disabled={isSaving}
            className="w-full border-2 border-gray-200 hover:border-gray-400 text-gray-700 font-bold py-3 rounded-xl transition disabled:opacity-50">
            {isSaving ? 'Setting up...' : "That's not me — create a new profile"}
          </button>
          <button onClick={() => setMatchingTeachers(null)} disabled={isSaving}
            className="w-full text-gray-400 hover:text-gray-600 text-sm mt-3 transition disabled:opacity-50">
            Go back
          </button>
          {error && <p className="text-red-500 text-sm mt-3 text-center">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full">
        <div className="text-center mb-6">
          <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold">Welcome to Tracker</h2>
          <p className="text-gray-500 mt-1">Let&apos;s set up your profile.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {role === 'admin' ? 'Your Name' : 'Your Last Name (e.g. Smith)'}
            </label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)} className="w-full border-gray-300 rounded-lg p-3 border focus:ring-green-500 focus:border-green-500" placeholder={role === 'admin' ? 'Admin' : 'Smith'} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Select Your Role</label>
            <div className="grid grid-cols-1 gap-3">
              {[
                { id: 'homeroom', icon: Users, title: 'Homeroom Teacher', desc: 'I have a primary class of students.' },
                { id: 'specialist', icon: Palette, title: 'Specialist', desc: 'I see multiple different classes.' },
                { id: 'admin', icon: Shield, title: 'Administrator', desc: 'I manage rosters and view school data.' }
              ].map(r => (
                <label key={r.id} className={`flex items-center p-4 border rounded-xl cursor-pointer transition ${role === r.id ? 'border-green-500 bg-green-50' : 'hover:bg-gray-50'}`}>
                  <input type="radio" name="role" value={r.id} checked={role === r.id} onChange={e => setRole(e.target.value)} className="sr-only" />
                  <r.icon className={`w-6 h-6 mr-4 ${role === r.id ? 'text-green-600' : 'text-gray-400'}`} />
                  <div>
                    <div className="font-bold text-gray-900">{r.title}</div>
                    <div className="text-xs text-gray-500">{r.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          {role === 'admin' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Admin Password</label>
              <input type="password" required value={adminPassword} onChange={e => { setAdminPassword(e.target.value); setPasswordError(''); }} className={`w-full border-gray-300 rounded-lg p-3 border focus:ring-green-500 focus:border-green-500 ${passwordError ? 'border-red-500' : ''}`} placeholder="Enter admin password" />
              {passwordError && <p className="text-red-500 text-sm mt-1">{passwordError}</p>}
            </div>
          )}
          <button type="submit" disabled={isSaving} className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition">
            {isSaving ? 'Setting up...' : 'Save & Continue'}
          </button>
          {error && <p className="text-red-500 text-sm mt-1 text-center">{error}</p>}
        </form>
      </div>
    </div>
  );
}

// --- Homeroom Dashboard ---
function HomeroomDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets, myUids }) {
  const [modalData, setModalData] = useState(null);

  const myStudents = useMemo(() => {
    const central = students.filter(s => s.homeroom === profile.name).map(s => s.name);
    const custom = profile.customStudents || [];
    return [...new Set([...central, ...custom])].sort();
  }, [students, profile]);

  const myTickets = tickets.filter(t => myUids.has(t.teacherId));
  const ticketCounts = {};
  myStudents.forEach(s => ticketCounts[s] = 0);
  myTickets.forEach(t => { if (ticketCounts[t.recipient] !== undefined) ticketCounts[t.recipient]++; });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);

  const handleGiveTicketDirect = async (recipient, reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    setSubmittingFor(recipient);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
      setSubmittingFor(null);
    }
  };

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    if (!modalData) return;
    const { recipient, type } = modalData;
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: type, reason, timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tickets', ticketId));
      showToast(`Removed ticket from ${recipient}.`);
    } catch (e) {
      console.error("Error removing ticket:", e);
      showToast("Error removing ticket.");
    }
  };

  const handleGoldenTicket = async () => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'goldenTickets'), {
        teacherId: user.uid, teacherName: profile.name,
        className: profile.name, timestamp: serverTimestamp()
      });
      showToast(`Golden Ticket awarded to ${profile.name}'s class!`);
    } catch (e) {
      console.error("Error awarding Golden Ticket:", e);
      showToast("Error awarding Golden Ticket.");
    }
  };

  const myClassGolden = goldenTickets.filter(g => g.className === profile.name).length;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Class Roster</h1>
          <p className="text-gray-500">Select a student to award a ticket.</p>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-500 font-medium">Tickets Given</div>
          <div className="text-3xl font-black text-green-600">{myTickets.length}</div>
        </div>
      </div>

      <div className="bg-gradient-to-r from-yellow-400 to-amber-500 p-5 rounded-2xl shadow-sm text-white flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Star className="w-8 h-8 text-yellow-100" />
          <div>
            <h3 className="text-lg font-bold">Golden Ticket</h3>
            <p className="text-yellow-100 text-sm">Award your class for awesome behavior! <span className="font-bold text-white">({myClassGolden} earned)</span></p>
          </div>
        </div>
        <button onClick={handleGoldenTicket} className="bg-white text-amber-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
          Award Golden Ticket
        </button>
      </div>

      <StudentSearch students={students} onSelect={setModalData} />

      {myTickets.length > 0 && <TicketBreakdownBar tickets={myTickets} />}
      <RecentTicketsList ticketList={myTickets} onRemove={handleRemoveTicket} />

      {myStudents.length === 0 ? (
        <div className="bg-white p-8 rounded-xl border text-center text-gray-500">
          <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p>No students assigned to &quot;{profile.name}&quot;.</p>
          <p className="text-sm mt-1">Admins can upload the central roster, or you can add custom students in settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {myStudents.map(student => (
            <StudentTicketCard key={student} student={student} tickets={myTickets}
              onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor} />
          ))}
        </div>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
    </div>
  );
}

// --- Specialist Dashboard (Nested View) ---
function SpecialistDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets, myUids }) {
  const [selectedClass, setSelectedClass] = useState(null);
  const [modalData, setModalData] = useState(null);

  const classes = useMemo(() => {
    const homerooms = students.map(s => s.homeroom).filter(Boolean);
    return [...new Set(homerooms)].sort();
  }, [students]);

  const studentsInClass = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter(s => s.homeroom === selectedClass).map(s => s.name).sort();
  }, [selectedClass, students]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);

  const handleGiveTicketDirect = async (recipient, reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    setSubmittingFor(recipient);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
      setSubmittingFor(null);
    }
  };

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    if (!modalData) return;
    const { recipient, type } = modalData;
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: type, reason, timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tickets', ticketId));
      showToast(`Removed ticket from ${recipient}.`);
    } catch (e) {
      console.error("Error removing ticket:", e);
      showToast("Error removing ticket.");
    }
  };

  const handleGoldenTicket = async (cls) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'goldenTickets'), {
        teacherId: user.uid, teacherName: profile.name,
        className: cls, timestamp: serverTimestamp()
      });
      showToast(`Golden Ticket awarded to ${cls}'s class!`);
    } catch (e) {
      console.error("Error awarding Golden Ticket:", e);
      showToast("Error awarding Golden Ticket.");
    }
  };

  const myTickets = tickets.filter(t => myUids.has(t.teacherId));

  return (
    <div className="space-y-6">
      {!selectedClass ? (
        <>
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900">School Classes</h1>
            <p className="text-gray-500">Select a class to award a whole-class ticket or individual students.</p>
          </div>
          <StudentSearch students={students} onSelect={setModalData} />
          {myTickets.length > 0 && <TicketBreakdownBar tickets={myTickets} />}
          <RecentTicketsList ticketList={myTickets} onRemove={handleRemoveTicket} />
          {classes.length === 0 ? (
            <div className="bg-white p-8 text-center rounded-xl border text-gray-500">No classes found in the central roster. Admin needs to upload CSV.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {classes.map(cls => {
                const gc = goldenTickets.filter(g => g.className === cls).length;
                return (
                  <button key={cls} onClick={() => setSelectedClass(cls)} className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 hover:border-green-500 transition flex items-center justify-between group">
                    <div className="flex items-center gap-4">
                      <div className="bg-blue-50 p-3 rounded-lg text-blue-600 group-hover:bg-blue-100"><Users className="w-6 h-6" /></div>
                      <div className="text-left">
                        <div className="font-bold text-lg text-gray-800">{cls}</div>
                        <div className="text-sm text-gray-500">View Roster</div>
                      </div>
                    </div>
                    {gc > 0 && <div className="flex items-center gap-1 bg-yellow-100 text-yellow-700 px-2.5 py-1 rounded-full text-xs font-bold"><Star className="w-3.5 h-3.5" />{gc}</div>}
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-4 mb-6">
            <button onClick={() => setSelectedClass(null)} className="p-2 bg-white border rounded-lg hover:bg-gray-50 text-gray-600"><ChevronLeft className="w-6 h-6" /></button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{selectedClass}&apos;s Class</h1>
              <p className="text-gray-500">Award the whole class, or pick a student.</p>
            </div>
          </div>
          <div className="bg-gradient-to-r from-yellow-400 to-amber-500 p-5 rounded-2xl shadow-sm mb-4 text-white flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Star className="w-7 h-7 text-yellow-100" />
              <div>
                <h3 className="text-lg font-bold">Golden Ticket</h3>
                <p className="text-yellow-100 text-sm">Reward the class for awesome behavior! <span className="font-bold text-white">({goldenTickets.filter(g => g.className === selectedClass).length} earned)</span></p>
              </div>
            </div>
            <button onClick={() => handleGoldenTicket(selectedClass)} className="bg-white text-amber-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
              Award Golden Ticket
            </button>
          </div>
          <div className="bg-gradient-to-r from-green-500 to-green-600 p-5 rounded-2xl shadow-sm mb-8 text-white flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold">Class-Wide Recognition</h3>
              <p className="text-green-100 text-sm">Award a regular ticket to the entire class.</p>
            </div>
            <button onClick={() => setModalData({ recipient: `${selectedClass} (Whole Class)`, type: 'class' })} className="bg-white text-green-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
              Award Whole Class
            </button>
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-4 border-b pb-2">Individual Students</h3>
          {studentsInClass.length === 0 ? (
            <p className="text-gray-500 italic">No students found in this homeroom.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {studentsInClass.map(student => (
                <StudentTicketCard key={student} student={student} tickets={myTickets}
                  onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor} />
              ))}
            </div>
          )}
        </>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
    </div>
  );
}

// --- Admin Dashboard (Includes CSV Upload + Give Tickets) ---
function AdminDashboard({ tickets, students, profiles, showToast, user, effectiveUid, profile, goldenTickets, myUids }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [csvText, setCsvText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedClass, setSelectedClass] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [activityPage, setActivityPage] = useState(0);
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState(null);
  const [isDeletingProfile, setIsDeletingProfile] = useState(false);
  const ITEMS_PER_PAGE = 25;

  const reasons = { Respectful: 0, Responsible: 0, Determined: 0 };
  tickets.forEach(t => { if (reasons[t.reason] !== undefined) reasons[t.reason]++; });

  const classes = useMemo(() => {
    const homerooms = students.map(s => s.homeroom).filter(Boolean);
    return [...new Set(homerooms)].sort();
  }, [students]);

  const studentsInClass = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter(s => s.homeroom === selectedClass).map(s => s.name).sort();
  }, [selectedClass, students]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);

  // Merge students state
  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  const handleGiveTicketDirect = async (recipient, reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    setSubmittingFor(recipient);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
      setSubmittingFor(null);
    }
  };

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    if (!modalData) return;
    const { recipient, type } = modalData;
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: type, reason, timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') showToast("Permission denied. Try closing and reopening the app.");
      else if (code === 'unavailable' || code === 'deadline-exceeded') showToast("Network issue. Please check your connection and try again.");
      else showToast(`Error saving ticket (${e?.code || 'unknown'}). Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'tickets', ticketId));
      showToast(`Removed ticket from ${recipient}.`);
    } catch (e) {
      console.error("Error removing ticket:", e);
      showToast("Error removing ticket.");
    }
  };

  const handleMergeStudents = async () => {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) return;
    setIsMerging(true);
    try {
      const batch = writeBatch(db);
      // Update all tickets from source to target
      const sourceTickets = tickets.filter(t => t.recipient === mergeSource);
      sourceTickets.forEach(t => {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'tickets', t.id);
        batch.update(ref, { recipient: mergeTarget });
      });
      // Remove source student docs from roster
      const sourceStudentDocs = students.filter(s => s.name === mergeSource);
      sourceStudentDocs.forEach(s => {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'students', s.id);
        batch.delete(ref);
      });
      await batch.commit();
      showToast(`Merged "${mergeSource}" into "${mergeTarget}". ${sourceTickets.length} ticket${sourceTickets.length !== 1 ? 's' : ''} reassigned.`);
      setMergeSource('');
      setMergeTarget('');
      setConfirmMerge(false);
    } catch (e) {
      console.error("Error merging students:", e);
      showToast(`Error merging students (${e?.code || 'unknown'}).`);
    }
    setIsMerging(false);
  };

  const handleGoldenTicket = async (cls) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'goldenTickets'), {
        teacherId: user.uid, teacherName: profile.name,
        className: cls, timestamp: serverTimestamp()
      });
      showToast(`Golden Ticket awarded to ${cls}'s class!`);
    } catch (e) {
      console.error("Error awarding Golden Ticket:", e);
      showToast("Error awarding Golden Ticket.");
    }
  };

  const handleRemoveGoldenTicket = async (ticketId, className) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'goldenTickets', ticketId));
      showToast(`Removed Golden Ticket from ${className}'s class.`);
    } catch (e) {
      console.error("Error removing Golden Ticket:", e);
      showToast("Error removing Golden Ticket.");
    }
  };

  const processCSV = async () => {
    if (!csvText.trim()) return;
    setIsProcessing(true);

    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsedStudents = lines.map(line => {
      const parts = line.split(',');
      return {
        name: parts[0]?.trim() || 'Unknown',
        homeroom: parts[1]?.trim() || 'Unassigned'
      };
    });

    try {
      const batch = writeBatch(db);
      parsedStudents.forEach(s => {
        const ref = doc(collection(db, 'artifacts', appId, 'public', 'data', 'students'));
        batch.set(ref, s);
      });
      await batch.commit();
      setCsvText('');
      showToast(`Successfully imported ${parsedStudents.length} students.`);
    } catch (e) {
      console.error(e);
      showToast("Error processing CSV.");
    }
    setIsProcessing(false);
  };

  const teacherTicketCounts = useMemo(() => {
    const counts = {};
    profiles.forEach(p => { counts[p.id] = 0; });
    tickets.forEach(t => {
      if (counts[t.teacherId] !== undefined) counts[t.teacherId]++;
      else counts[t.teacherId] = 1;
    });
    return counts;
  }, [profiles, tickets]);

  const unusedProfiles = useMemo(() =>
    profiles.filter(p => p.name && !p.linkedTo && (teacherTicketCounts[p.id] || 0) === 0 && p.id !== effectiveUid),
  [profiles, teacherTicketCounts, effectiveUid]);

  const handleDeleteProfile = async (profileToDelete) => {
    setIsDeletingProfile(true);
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', profileToDelete.id));
      // Best-effort cleanup of linked device docs — failures are non-fatal
      const linkedDevices = profiles.filter(p => p.linkedTo === profileToDelete.id);
      await Promise.allSettled(linkedDevices.map(d =>
        deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', d.id))
      ));
      showToast(`Deleted profile for ${profileToDelete.name}.`);
      setConfirmDeleteProfile(null);
    } catch (e) {
      console.error("Error deleting profile:", e);
      const code = e?.code || '';
      if (code === 'permission-denied') {
        showToast("Permission denied. Check Firestore rules allow admin to delete user docs.");
      } else {
        showToast(`Error deleting profile (${code || 'unknown'}).`);
      }
    }
    setIsDeletingProfile(false);
  };

  const clearRoster = async () => {
    setIsClearing(true);
    try {
      const batch = writeBatch(db);
      students.forEach(s => {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'students', s.id);
        batch.delete(ref);
      });
      await batch.commit();
      showToast(`Cleared ${students.length} students from the roster.`);
      setConfirmClear(false);
    } catch (e) {
      console.error(e);
      showToast("Error clearing roster.");
    }
    setIsClearing(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 border-b pb-4">
        <h1 className="text-3xl font-bold text-gray-900">Admin Controls</h1>
        <div className="flex flex-wrap bg-gray-200 p-1 rounded-lg gap-0.5">
          <button onClick={() => setActiveTab('overview')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'overview' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Overview</button>
          <button onClick={() => setActiveTab('tickets')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'tickets' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Give Tickets</button>
          <button onClick={() => setActiveTab('merge')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'merge' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Merge Students</button>
          <button onClick={() => setActiveTab('teachers')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'teachers' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Teachers{unusedProfiles.length > 0 && <span className="ml-1.5 bg-red-100 text-red-700 rounded-full px-1.5 py-0.5 text-xs font-bold">{unusedProfiles.length}</span>}</button>
          <button onClick={() => setActiveTab('roster')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'roster' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Roster Sync (CSV)</button>
        </div>
      </div>

      {activeTab === 'tickets' ? (
        <div className="space-y-6">
          {!selectedClass ? (
            <>
              <div className="mb-2">
                <h2 className="text-xl font-bold text-gray-900">Select a Class</h2>
                <p className="text-gray-500 text-sm">Choose a class to award tickets to the whole class or individual students.</p>
              </div>
              <StudentSearch students={students} onSelect={setModalData} />
              {classes.length === 0 ? (
                <div className="bg-white p-8 text-center rounded-xl border text-gray-500">No classes found. Import a roster first.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {classes.map(cls => {
                    const gc = goldenTickets.filter(g => g.className === cls).length;
                    return (
                      <button key={cls} onClick={() => setSelectedClass(cls)} className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 hover:border-green-500 transition flex items-center justify-between group">
                        <div className="flex items-center gap-4">
                          <div className="bg-green-50 p-3 rounded-lg text-green-600 group-hover:bg-green-100"><Users className="w-6 h-6" /></div>
                          <div className="text-left"><div className="font-bold text-lg text-gray-800">{cls}</div><div className="text-sm text-gray-500">{students.filter(s => s.homeroom === cls).length} students</div></div>
                        </div>
                        {gc > 0 && <div className="flex items-center gap-1 bg-yellow-100 text-yellow-700 px-2.5 py-1 rounded-full text-xs font-bold"><Star className="w-3.5 h-3.5" />{gc}</div>}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-2">
                <button onClick={() => setSelectedClass(null)} className="p-2 bg-white border rounded-lg hover:bg-gray-50 text-gray-600"><ChevronLeft className="w-6 h-6" /></button>
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{selectedClass}&apos;s Class</h2>
                  <p className="text-gray-500 text-sm">Award the whole class or pick a student.</p>
                </div>
              </div>
              <div className="bg-gradient-to-r from-yellow-400 to-amber-500 p-5 rounded-2xl shadow-sm mb-4 text-white flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Star className="w-7 h-7 text-yellow-100" />
                  <div>
                    <h3 className="text-lg font-bold">Golden Ticket</h3>
                    <p className="text-yellow-100 text-sm">Reward the class for awesome behavior! <span className="font-bold text-white">({goldenTickets.filter(g => g.className === selectedClass).length} earned)</span></p>
                  </div>
                </div>
                <button onClick={() => handleGoldenTicket(selectedClass)} className="bg-white text-amber-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
                  Award Golden Ticket
                </button>
              </div>
              {goldenTickets.filter(g => g.className === selectedClass).length > 0 && (
                <div className="bg-white rounded-xl shadow-sm border overflow-hidden mb-4">
                  <div className="px-5 py-3 border-b bg-yellow-50 flex items-center justify-between">
                    <h3 className="font-bold text-yellow-800 text-sm flex items-center gap-2"><Star className="w-4 h-4" /> Golden Tickets for {selectedClass}</h3>
                    <span className="text-xs text-gray-400">Tap trash to remove</span>
                  </div>
                  <div className="divide-y">
                    {[...goldenTickets].filter(g => g.className === selectedClass).sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0)).map(g => (
                      <div key={g.id} className="flex items-center justify-between px-5 py-2.5 hover:bg-gray-50 transition">
                        <div className="flex items-center gap-3">
                          <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" />
                          <span className="font-medium text-gray-800 text-sm">Awarded by {g.teacherName}</span>
                          <span className="text-xs text-gray-400 flex-shrink-0">{g.timestamp ? g.timestamp.toDate().toLocaleDateString() : 'Now'}</span>
                        </div>
                        <button onClick={() => handleRemoveGoldenTicket(g.id, g.className)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition flex-shrink-0 ml-2">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="bg-gradient-to-r from-green-500 to-green-600 p-5 rounded-2xl shadow-sm mb-4 text-white flex flex-col sm:flex-row items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold">Class-Wide Recognition</h3>
                  <p className="text-green-100 text-sm">Award a regular ticket to the entire class.</p>
                </div>
                <button onClick={() => setModalData({ recipient: `${selectedClass} (Whole Class)`, type: 'class' })} className="bg-white text-green-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
                  Award Whole Class
                </button>
              </div>
              <h3 className="text-lg font-bold text-gray-800 mb-4 border-b pb-2">Individual Students</h3>
              {studentsInClass.length === 0 ? (
                <p className="text-gray-500 italic">No students found in this homeroom.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {studentsInClass.map(student => (
                    <StudentTicketCard key={student} student={student} tickets={tickets}
                      onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor} />
                  ))}
                </div>
              )}
            </>
          )}
          {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
        </div>
      ) : activeTab === 'overview' ? (
        <>
          {/* Summary stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-3 bg-green-100 rounded-full text-green-600"><Award className="w-7 h-7" /></div>
              <div><div className="text-xs text-gray-500 font-medium">Total Tickets</div><div className="text-2xl font-bold">{tickets.length}</div></div>
            </div>
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-3 bg-yellow-100 rounded-full text-yellow-600"><Star className="w-7 h-7" /></div>
              <div><div className="text-xs text-gray-500 font-medium">Golden Tickets</div><div className="text-2xl font-bold">{goldenTickets.length}</div></div>
            </div>
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-full text-blue-600"><Users className="w-7 h-7" /></div>
              <div><div className="text-xs text-gray-500 font-medium">Active Teachers</div><div className="text-2xl font-bold">{new Set(tickets.map(t => t.teacherId)).size}</div></div>
            </div>
            <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-3 bg-purple-100 rounded-full text-purple-600"><PieChart className="w-7 h-7" /></div>
              <div><div className="text-xs text-gray-500 font-medium">Students in Roster</div><div className="text-2xl font-bold">{students.length}</div></div>
            </div>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            {/* Ticket Type Breakdown */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h3 className="font-bold text-gray-800 text-sm mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-gray-400" /> Ticket Type Breakdown</h3>
              {tickets.length === 0 ? <p className="text-gray-400 text-sm">No tickets yet.</p> : (
                <>
                  <div className="flex rounded-full overflow-hidden h-8 bg-gray-100 mb-4">
                    {reasons.Respectful > 0 && <div className="bg-blue-500 transition-all duration-500 flex items-center justify-center text-white text-xs font-bold" style={{ width: `${(reasons.Respectful / tickets.length) * 100}%` }}>{reasons.Respectful}</div>}
                    {reasons.Responsible > 0 && <div className="bg-amber-500 transition-all duration-500 flex items-center justify-center text-white text-xs font-bold" style={{ width: `${(reasons.Responsible / tickets.length) * 100}%` }}>{reasons.Responsible}</div>}
                    {reasons.Determined > 0 && <div className="bg-purple-500 transition-all duration-500 flex items-center justify-center text-white text-xs font-bold" style={{ width: `${(reasons.Determined / tickets.length) * 100}%` }}>{reasons.Determined}</div>}
                  </div>
                  <div className="flex justify-between text-xs font-semibold">
                    <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500" /><span className="text-gray-600">Respectful</span><span className="text-gray-900">{reasons.Respectful} ({tickets.length > 0 ? Math.round(reasons.Respectful / tickets.length * 100) : 0}%)</span></div>
                    <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-amber-500" /><span className="text-gray-600">Responsible</span><span className="text-gray-900">{reasons.Responsible} ({tickets.length > 0 ? Math.round(reasons.Responsible / tickets.length * 100) : 0}%)</span></div>
                    <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-purple-500" /><span className="text-gray-600">Determined</span><span className="text-gray-900">{reasons.Determined} ({tickets.length > 0 ? Math.round(reasons.Determined / tickets.length * 100) : 0}%)</span></div>
                  </div>
                </>
              )}
            </div>

            {/* Top 10 Students */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h3 className="font-bold text-gray-800 text-sm mb-4 flex items-center gap-2"><Crown className="w-4 h-4 text-yellow-500" /> Top 10 Students (Most Tickets)</h3>
              {(() => {
                const studentCounts = {};
                tickets.filter(t => t.recipientType === 'student').forEach(t => { studentCounts[t.recipient] = (studentCounts[t.recipient] || 0) + 1; });
                const sorted = Object.entries(studentCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
                const maxCount = sorted[0]?.[1] || 1;
                if (sorted.length === 0) return <p className="text-gray-400 text-sm">No student tickets yet.</p>;
                return (
                  <div className="space-y-2">
                    {sorted.map(([name, count], i) => (
                      <div key={name} className="flex items-center gap-3">
                        <span className={`w-6 text-xs font-bold text-right ${i < 3 ? 'text-yellow-600' : 'text-gray-400'}`}>{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-sm font-medium text-gray-800 truncate">{name}</span>
                            <span className="text-sm font-bold text-green-700 ml-2">{count}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-500 ${i === 0 ? 'bg-yellow-400' : i === 1 ? 'bg-gray-400' : i === 2 ? 'bg-amber-600' : 'bg-green-400'}`} style={{ width: `${(count / maxCount) * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Tickets by Teacher */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h3 className="font-bold text-gray-800 text-sm mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-green-500" /> Tickets by Teacher</h3>
              {(() => {
                const teacherCounts = {};
                tickets.forEach(t => { teacherCounts[t.teacherName] = (teacherCounts[t.teacherName] || 0) + 1; });
                const sorted = Object.entries(teacherCounts).sort((a, b) => b[1] - a[1]);
                const maxCount = sorted[0]?.[1] || 1;
                if (sorted.length === 0) return <p className="text-gray-400 text-sm">No tickets yet.</p>;
                return (
                  <div className="space-y-2">
                    {sorted.map(([name, count]) => (
                      <div key={name} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold flex-shrink-0">{name.charAt(0).toUpperCase()}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-sm font-medium text-gray-800 truncate">{name}</span>
                            <span className="text-sm font-bold text-green-700 ml-2">{count}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-green-500 transition-all duration-500" style={{ width: `${(count / maxCount) * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Tickets by Class */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h3 className="font-bold text-gray-800 text-sm mb-4 flex items-center gap-2"><Users className="w-4 h-4 text-blue-500" /> Tickets by Homeroom Class</h3>
              {(() => {
                const studentHomeroom = {};
                students.forEach(s => { studentHomeroom[s.name] = s.homeroom; });
                const classCounts = {};
                tickets.filter(t => t.recipientType === 'student').forEach(t => {
                  const hr = studentHomeroom[t.recipient] || 'Unknown';
                  classCounts[hr] = (classCounts[hr] || 0) + 1;
                });
                const sorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
                const maxCount = sorted[0]?.[1] || 1;
                if (sorted.length === 0) return <p className="text-gray-400 text-sm">No student tickets yet.</p>;
                return (
                  <div className="space-y-2">
                    {sorted.map(([name, count]) => (
                      <div key={name} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold flex-shrink-0">{name.charAt(0).toUpperCase()}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-sm font-medium text-gray-800 truncate">{name}</span>
                            <span className="text-sm font-bold text-blue-700 ml-2">{count}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${(count / maxCount) * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* All Activity table (kept) */}
          <div className="bg-white rounded-xl shadow-sm border mt-6 overflow-hidden">
            <div className="px-6 py-4 border-b bg-gray-50 flex items-center justify-between">
              <h3 className="font-bold text-gray-800">All Activity</h3>
              <span className="text-xs text-gray-500">{tickets.length + goldenTickets.length} total entries</span>
            </div>
            <div className="overflow-x-auto">
              {(() => {
                const allActivity = [
                  ...tickets.map(t => ({ ...t, _type: 'ticket' })),
                  ...goldenTickets.map(g => ({ ...g, _type: 'golden' }))
                ].sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
                const totalPages = Math.max(1, Math.ceil(allActivity.length / ITEMS_PER_PAGE));
                const pageItems = allActivity.slice(activityPage * ITEMS_PER_PAGE, (activityPage + 1) * ITEMS_PER_PAGE);
                return <>
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="bg-gray-50 border-b">
                  <tr><th className="px-6 py-3">Time</th><th className="px-6 py-3">Teacher</th><th className="px-6 py-3">Recipient</th><th className="px-6 py-3">Reason</th><th className="px-6 py-3 w-12"></th></tr>
                </thead>
                <tbody className="divide-y">
                  {pageItems.map(t => (
                    <tr key={t.id}>
                      <td className="px-6 py-3">{t.timestamp ? t.timestamp.toDate().toLocaleString() : 'Now'}</td>
                      <td className="px-6 py-3 font-medium text-gray-900">{t.teacherName}</td>
                      <td className="px-6 py-3">{t._type === 'golden' ? `${t.className} (Class)` : <>{t.recipient} {t.recipientType === 'class' && '(Class)'}</>}</td>
                      <td className="px-6 py-3">
                        {t._type === 'golden'
                          ? <span className="px-2 py-1 rounded-full text-xs font-bold bg-yellow-100 text-yellow-800 inline-flex items-center gap-1"><Star className="w-3 h-3" />Golden</span>
                          : <span className={`px-2 py-1 rounded-full text-xs font-bold ${t.reason === 'Respectful' ? 'bg-blue-100 text-blue-800' : t.reason === 'Responsible' ? 'bg-amber-100 text-amber-800' : 'bg-purple-100 text-purple-800'}`}>{t.reason}</span>
                        }
                      </td>
                      <td className="px-6 py-3">
                        <button onClick={() => t._type === 'golden' ? handleRemoveGoldenTicket(t.id, t.className) : handleRemoveTicket(t.id, t.recipient)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div className="px-6 py-3 border-t bg-gray-50 flex items-center justify-between">
                  <button onClick={() => setActivityPage(p => Math.max(0, p - 1))} disabled={activityPage === 0} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white border hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition">
                    Previous
                  </button>
                  <span className="text-sm text-gray-600">Page {activityPage + 1} of {totalPages}</span>
                  <button onClick={() => setActivityPage(p => Math.min(totalPages - 1, p + 1))} disabled={activityPage >= totalPages - 1} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white border hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition">
                    Next
                  </button>
                </div>
              )}
                </>;
              })()}
            </div>
          </div>
        </>
      ) : activeTab === 'merge' ? (
        <div className="max-w-2xl space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-indigo-100 rounded-full text-indigo-600"><GitMerge className="w-6 h-6" /></div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Merge Student Profiles</h2>
                <p className="text-sm text-gray-500">Combine two student profiles into one. All tickets from the source student will be reassigned to the target, and the source will be removed from the roster.</p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-6 text-sm text-amber-800">
              <strong>Note:</strong> This action cannot be undone. The source student&apos;s name will be removed and all their tickets transferred to the target student.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-4 items-end mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Source (will be removed)</label>
                <select value={mergeSource} onChange={e => { setMergeSource(e.target.value); setConfirmMerge(false); }}
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-indigo-500 focus:border-indigo-500">
                  <option value="">Select student...</option>
                  {[...new Set(students.map(s => s.name))].sort().filter(n => n !== mergeTarget).map(name => {
                    const count = tickets.filter(t => t.recipient === name).length;
                    return <option key={name} value={name}>{name} ({count} ticket{count !== 1 ? 's' : ''})</option>;
                  })}
                </select>
              </div>
              <div className="flex items-center justify-center py-2">
                <ArrowRight className="w-6 h-6 text-gray-400" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target (will keep)</label>
                <select value={mergeTarget} onChange={e => { setMergeTarget(e.target.value); setConfirmMerge(false); }}
                  className="w-full border border-gray-300 rounded-lg p-3 text-sm focus:ring-indigo-500 focus:border-indigo-500">
                  <option value="">Select student...</option>
                  {[...new Set(students.map(s => s.name))].sort().filter(n => n !== mergeSource).map(name => {
                    const count = tickets.filter(t => t.recipient === name).length;
                    return <option key={name} value={name}>{name} ({count} ticket{count !== 1 ? 's' : ''})</option>;
                  })}
                </select>
              </div>
            </div>

            {mergeSource && mergeTarget && (
              <div className="bg-gray-50 rounded-lg p-4 mb-4 text-sm">
                <p className="font-medium text-gray-800 mb-2">Merge Preview:</p>
                <div className="flex items-center gap-2 text-gray-600">
                  <span className="font-bold text-red-600">{mergeSource}</span>
                  <span className="text-gray-400">({tickets.filter(t => t.recipient === mergeSource).length} tickets)</span>
                  <ArrowRight className="w-4 h-4 text-gray-400" />
                  <span className="font-bold text-green-600">{mergeTarget}</span>
                  <span className="text-gray-400">({tickets.filter(t => t.recipient === mergeTarget).length} tickets)</span>
                </div>
                <p className="text-gray-500 mt-1">After merge: <strong className="text-gray-800">{mergeTarget}</strong> will have <strong>{tickets.filter(t => t.recipient === mergeSource || t.recipient === mergeTarget).length}</strong> total tickets.</p>
              </div>
            )}

            {!confirmMerge ? (
              <button onClick={() => setConfirmMerge(true)} disabled={!mergeSource || !mergeTarget || mergeSource === mergeTarget}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-xl transition flex items-center gap-2">
                <GitMerge className="w-4 h-4" /> Merge Students
              </button>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <p className="text-red-800 font-medium mb-3">Are you sure? This will permanently merge &quot;{mergeSource}&quot; into &quot;{mergeTarget}&quot; and remove &quot;{mergeSource}&quot; from the roster.</p>
                <div className="flex gap-3">
                  <button onClick={handleMergeStudents} disabled={isMerging} className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-2 px-5 rounded-lg transition text-sm">
                    {isMerging ? 'Merging...' : 'Yes, Merge Now'}
                  </button>
                  <button onClick={() => setConfirmMerge(false)} className="bg-white hover:bg-gray-50 text-gray-700 font-bold py-2 px-5 rounded-lg transition border text-sm">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : activeTab === 'teachers' ? (
        <div className="bg-white rounded-xl shadow-sm border max-w-3xl">
          <div className="px-6 py-4 border-b bg-gray-50 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">Teacher Profiles</h2>
              <p className="text-sm text-gray-500 mt-0.5">Profiles with 0 tickets can be deleted.</p>
            </div>
            <span className="text-xs text-gray-500">{profiles.length} total</span>
          </div>
          <div className="divide-y">
            {profiles.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">No profiles found.</div>
            )}
            {[...profiles].filter(p => p.name && !p.linkedTo).sort((a, b) => (teacherTicketCounts[b.id] || 0) - (teacherTicketCounts[a.id] || 0)).map(p => {
              const count = teacherTicketCounts[p.id] || 0;
              const isCurrentUser = p.id === effectiveUid;
              const linkedCount = profiles.filter(x => x.linkedTo === p.id).length;
              return (
                <div key={p.id} className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${count === 0 ? 'bg-gray-100 text-gray-400' : 'bg-green-100 text-green-700'}`}>
                      {p.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 flex items-center gap-2">
                        {p.name}
                        {isCurrentUser && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">You</span>}
                        {p.linkedTo && <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">Linked device</span>}
                      </div>
                      <div className="text-xs text-gray-500 capitalize">{p.role}{linkedCount > 0 ? ` · ${linkedCount} linked device${linkedCount > 1 ? 's' : ''}` : ''}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-medium ${count === 0 ? 'text-gray-400' : 'text-green-700'}`}>{count} ticket{count !== 1 ? 's' : ''}</span>
                    {!isCurrentUser && count === 0 && !p.linkedTo && (
                      confirmDeleteProfile?.id === p.id ? (
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleDeleteProfile(p)} disabled={isDeletingProfile} className="text-xs bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold px-3 py-1.5 rounded-lg transition">
                            {isDeletingProfile ? 'Deleting…' : 'Confirm'}
                          </button>
                          <button onClick={() => setConfirmDeleteProfile(null)} className="text-xs bg-white border hover:bg-gray-50 text-gray-700 font-bold px-3 py-1.5 rounded-lg transition">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteProfile(p)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-white p-6 rounded-xl shadow-sm border max-w-3xl">
          <h2 className="text-xl font-bold mb-2">Central Roster Import</h2>
          <p className="text-gray-600 text-sm mb-6">
            Paste data from Excel/Sheets to populate the central database. Format must be exactly: <strong>Student Name, Homeroom Teacher</strong> (one per line).
            <br /><em>Example: <br />Jane Doe, Mr. Smith <br />John Smith, Ms. Davis</em>
          </p>

          <textarea
            rows="10"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className="w-full border-gray-300 rounded-lg p-4 font-mono text-sm bg-gray-50 focus:border-green-500 focus:ring-green-500 border mb-4"
            placeholder={"Jane Doe, Mr. Smith\nJohn Smith, Ms. Davis"}
          />
          <button
            onClick={processCSV}
            disabled={isProcessing || !csvText}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-xl transition flex items-center gap-2">
            {isProcessing ? 'Processing...' : 'Upload & Sync Database'}
          </button>

          <div className="mt-8 pt-6 border-t">
            <h3 className="font-bold text-gray-800 mb-2">Current Database Status</h3>
            <p className="text-gray-600 mb-4">Total Students in Database: <strong>{students.length}</strong></p>

            {students.length > 0 && (
              !confirmClear ? (
                <button onClick={() => setConfirmClear(true)} className="bg-red-50 hover:bg-red-100 text-red-700 font-bold py-2.5 px-5 rounded-xl transition border border-red-200 hover:border-red-400 text-sm">
                  Clear Entire Roster
                </button>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-red-800 font-medium mb-3">Are you sure? This will permanently delete all {students.length} students from the roster.</p>
                  <div className="flex gap-3">
                    <button onClick={clearRoster} disabled={isClearing} className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-2 px-5 rounded-lg transition text-sm">
                      {isClearing ? 'Clearing...' : 'Yes, Clear All'}
                    </button>
                    <button onClick={() => setConfirmClear(false)} className="bg-white hover:bg-gray-50 text-gray-700 font-bold py-2 px-5 rounded-lg transition border text-sm">
                      Cancel
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Shared Modals ---
function GiveTicketModal({ data, onClose, onSelect, isSubmitting }) {
  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="p-6 text-center">
          <div className="flex justify-end mb-2">
            <button onClick={onClose} disabled={isSubmitting} className="text-gray-400 hover:text-gray-600 disabled:opacity-50"><X className="w-6 h-6" /></button>
          </div>
          <h3 className="text-gray-500 font-semibold uppercase tracking-wider text-sm mb-1">Award Ticket To</h3>
          <p className="text-2xl font-black text-gray-900 mb-8">{data.recipient}</p>

          <div className="space-y-3">
            <button disabled={isSubmitting} onClick={() => onSelect('Respectful')} className="w-full py-4 px-6 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl font-bold text-lg border-2 border-blue-200 hover:border-blue-400 transition-all text-left flex justify-between disabled:opacity-50 disabled:cursor-not-allowed">
              {isSubmitting ? 'Saving...' : 'Respectful'} <span className="text-blue-400">&#x1F91D;</span>
            </button>
            <button disabled={isSubmitting} onClick={() => onSelect('Responsible')} className="w-full py-4 px-6 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-xl font-bold text-lg border-2 border-amber-200 hover:border-amber-400 transition-all text-left flex justify-between disabled:opacity-50 disabled:cursor-not-allowed">
              {isSubmitting ? 'Saving...' : 'Responsible'} <span className="text-amber-400">&#x1F4CB;</span>
            </button>
            <button disabled={isSubmitting} onClick={() => onSelect('Determined')} className="w-full py-4 px-6 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-xl font-bold text-lg border-2 border-purple-200 hover:border-purple-400 transition-all text-left flex justify-between disabled:opacity-50 disabled:cursor-not-allowed">
              {isSubmitting ? 'Saving...' : 'Determined'} <span className="text-purple-400">&#x1F525;</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
