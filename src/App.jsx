import React, { useState, useEffect, useMemo } from 'react';
import {
  Ticket, Users, Shield, Palette, Download,
  Award, PieChart, ChevronLeft, CheckCircle2, X, AlertTriangle, Trash2, Star, Search
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAnalytics } from 'firebase/analytics';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore, collection, doc, setDoc, onSnapshot,
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
const db = getFirestore(app);

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
  const backfillRan = React.useRef(false);

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

  // 2. Fetch Data (Only after auth)
  useEffect(() => {
    if (!user) return;
    const profilesRef = collection(db, 'artifacts', appId, 'public', 'data', 'users');
    const ticketsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tickets');
    const studentsRef = collection(db, 'artifacts', appId, 'public', 'data', 'students');
    const goldenRef = collection(db, 'artifacts', appId, 'public', 'data', 'goldenTickets');

    const unsubProfiles = onSnapshot(profilesRef, (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setProfiles(data);
      const myDoc = data.find(p => p.id === user.uid);
      if (myDoc && myDoc.linkedTo) {
        // This device is linked to another teacher's account
        const primaryProfile = data.find(p => p.id === myDoc.linkedTo);
        if (!primaryProfile) {
          console.warn("Linked primary profile not found:", myDoc.linkedTo);
        }
        setProfile(primaryProfile || null);
        setEffectiveUid(myDoc.linkedTo);
      } else {
        setProfile(myDoc || null);
        setEffectiveUid(myDoc ? user.uid : null);
      }

      if (snap.metadata.fromCache === false) setLoading(false);
    });

    const unsubTickets = onSnapshot(ticketsRef, (snap) => {
      setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubStudents = onSnapshot(studentsRef, (snap) => {
      setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubGolden = onSnapshot(goldenRef, (snap) => {
      setGoldenTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    return () => { unsubProfiles(); unsubTickets(); unsubStudents(); unsubGolden(); };
  }, [user]);

  // One-time backfill: add nameNormalized to existing profiles that are missing it
  useEffect(() => {
    if (backfillRan.current || profiles.length === 0) return;
    const needsMigration = profiles.filter(p => p.name && !p.nameNormalized);
    if (needsMigration.length === 0) return;
    backfillRan.current = true;
    needsMigration.forEach((p) => {
      setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'users', p.id),
        { nameNormalized: p.name.trim().toLowerCase() },
        { merge: true }
      ).catch(e => console.error("Migration error for", p.id, e));
    });
  }, [profiles]);

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

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans text-gray-800">
      <Navbar profile={profile} tickets={tickets} />

      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        {profile.role === 'admin' && (
          <AdminDashboard tickets={tickets} students={students} profiles={profiles} showToast={showToast} user={user} effectiveUid={effectiveUid} profile={profile} goldenTickets={goldenTickets} />
        )}
        {profile.role === 'homeroom' && (
          <HomeroomDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} effectiveUid={effectiveUid} goldenTickets={goldenTickets} />
        )}
        {profile.role === 'specialist' && (
          <SpecialistDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} effectiveUid={effectiveUid} goldenTickets={goldenTickets} />
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

// --- Components ---
function Navbar({ profile, tickets }) {
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
      // Check if a teacher with this name and role already exists (case-insensitive)
      const usersRef = collection(db, 'artifacts', appId, 'public', 'data', 'users');
      const q = query(usersRef, where('nameNormalized', '==', name.trim().toLowerCase()), where('role', '==', role));
      const snap = await getDocs(q);

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
function HomeroomDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets }) {
  const [modalData, setModalData] = useState(null);

  const myStudents = useMemo(() => {
    const central = students.filter(s => s.homeroom === profile.name).map(s => s.name);
    const custom = profile.customStudents || [];
    return [...new Set([...central, ...custom])].sort();
  }, [students, profile]);

  const myTickets = tickets.filter(t => t.teacherId === effectiveUid);
  const ticketCounts = {};
  myStudents.forEach(s => ticketCounts[s] = 0);
  myTickets.forEach(t => { if (ticketCounts[t.recipient] !== undefined) ticketCounts[t.recipient]++; });

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: effectiveUid,
        teacherName: profile.name,
        recipient: modalData.recipient,
        recipientType: modalData.type,
        reason,
        timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${modalData.recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast("Error saving ticket. Please check your connection and try again.");
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
        teacherId: effectiveUid, teacherName: profile.name,
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
          {myStudents.map(student => {
            const rc = getStudentReasonCounts(student, myTickets);
            const noRecent = !hasRecentTicket(student, myTickets);
            return (
              <button key={student} onClick={() => setModalData({ recipient: student, type: 'student' })}
                className={`p-4 rounded-xl shadow-sm border hover:shadow-md transition text-left flex flex-col justify-between h-32 group ${noRecent ? 'bg-red-50 border-red-300 hover:border-red-500' : 'bg-white border-gray-200 hover:border-green-500'}`}>
                <div className="flex items-start justify-between w-full">
                  <span className={`font-bold leading-tight text-sm ${noRecent ? 'text-red-800' : 'text-gray-800 group-hover:text-green-700'}`}>{student}</span>
                  {noRecent && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 ml-1" />}
                </div>
                <div className="w-full mt-auto">
                  <div className="flex gap-1.5 mb-1.5">
                    {rc.Respectful > 0 && <span className="bg-blue-100 text-blue-700 text-xs font-bold px-1.5 py-0.5 rounded">R {rc.Respectful}</span>}
                    {rc.Responsible > 0 && <span className="bg-amber-100 text-amber-700 text-xs font-bold px-1.5 py-0.5 rounded">S {rc.Responsible}</span>}
                    {rc.Determined > 0 && <span className="bg-purple-100 text-purple-700 text-xs font-bold px-1.5 py-0.5 rounded">D {rc.Determined}</span>}
                  </div>
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Total</span>
                    <span className={`py-0.5 px-2.5 rounded-full font-black text-sm ${noRecent ? 'bg-red-100 text-red-700' : 'bg-green-50 text-green-700'}`}>{ticketCounts[student]}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
    </div>
  );
}

// --- Specialist Dashboard (Nested View) ---
function SpecialistDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets }) {
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

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: effectiveUid,
        teacherName: profile.name,
        recipient: modalData.recipient,
        recipientType: modalData.type,
        reason,
        timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${modalData.recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast("Error saving ticket. Please check your connection and try again.");
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
        teacherId: effectiveUid, teacherName: profile.name,
        className: cls, timestamp: serverTimestamp()
      });
      showToast(`Golden Ticket awarded to ${cls}'s class!`);
    } catch (e) {
      console.error("Error awarding Golden Ticket:", e);
      showToast("Error awarding Golden Ticket.");
    }
  };

  const myTickets = tickets.filter(t => t.teacherId === effectiveUid);

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
              {studentsInClass.map(student => {
                const rc = getStudentReasonCounts(student, myTickets);
                const noRecent = !hasRecentTicket(student, myTickets);
                const total = rc.Respectful + rc.Responsible + rc.Determined;
                return (
                  <button key={student} onClick={() => setModalData({ recipient: student, type: 'student' })}
                    className={`p-4 rounded-xl shadow-sm border hover:shadow-md transition text-left flex flex-col justify-between h-32 group ${noRecent ? 'bg-red-50 border-red-300 hover:border-red-500' : 'bg-white border-gray-200 hover:border-blue-500'}`}>
                    <div className="flex items-start justify-between w-full">
                      <span className={`font-bold leading-tight text-sm ${noRecent ? 'text-red-800' : 'text-gray-800'}`}>{student}</span>
                      {noRecent && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 ml-1" />}
                    </div>
                    <div className="w-full mt-auto">
                      <div className="flex gap-1.5 mb-1.5">
                        {rc.Respectful > 0 && <span className="bg-blue-100 text-blue-700 text-xs font-bold px-1.5 py-0.5 rounded">R {rc.Respectful}</span>}
                        {rc.Responsible > 0 && <span className="bg-amber-100 text-amber-700 text-xs font-bold px-1.5 py-0.5 rounded">S {rc.Responsible}</span>}
                        {rc.Determined > 0 && <span className="bg-purple-100 text-purple-700 text-xs font-bold px-1.5 py-0.5 rounded">D {rc.Determined}</span>}
                      </div>
                      {total > 0 && (
                        <div className="flex items-center justify-between w-full">
                          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Total</span>
                          <span className={`py-0.5 px-2.5 rounded-full font-black text-sm ${noRecent ? 'bg-red-100 text-red-700' : 'bg-green-50 text-green-700'}`}>{total}</span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
    </div>
  );
}

// --- Admin Dashboard (Includes CSV Upload + Give Tickets) ---
function AdminDashboard({ tickets, students, profiles, showToast, user, effectiveUid, profile, goldenTickets }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [csvText, setCsvText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedClass, setSelectedClass] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [activityPage, setActivityPage] = useState(0);
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

  const handleGiveTicket = async (reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: effectiveUid,
        teacherName: profile.name,
        recipient: modalData.recipient,
        recipientType: modalData.type,
        reason,
        timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${modalData.recipient}!`);
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast("Error saving ticket. Please check your connection and try again.");
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
        teacherId: effectiveUid, teacherName: profile.name,
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
        <div className="flex bg-gray-200 p-1 rounded-lg">
          <button onClick={() => setActiveTab('overview')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'overview' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Overview</button>
          <button onClick={() => setActiveTab('tickets')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'tickets' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Give Tickets</button>
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
                    <button key={student} onClick={() => setModalData({ recipient: student, type: 'student' })} className="bg-white p-5 rounded-xl shadow-sm border border-gray-200 hover:border-green-500 hover:shadow-md transition text-left h-24 flex items-center">
                      <span className="font-bold text-gray-800 leading-tight">{student}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
        </div>
      ) : activeTab === 'overview' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-4 bg-green-100 rounded-full text-green-600"><Award className="w-8 h-8" /></div>
              <div><div className="text-sm text-gray-500 font-medium">Total Tickets</div><div className="text-3xl font-bold">{tickets.length}</div></div>
            </div>
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-4 bg-yellow-100 rounded-full text-yellow-600"><Star className="w-8 h-8" /></div>
              <div><div className="text-sm text-gray-500 font-medium">Golden Tickets</div><div className="text-3xl font-bold">{goldenTickets.length}</div></div>
            </div>
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-4 bg-blue-100 rounded-full text-blue-600"><Users className="w-8 h-8" /></div>
              <div><div className="text-sm text-gray-500 font-medium">Active Teachers</div><div className="text-3xl font-bold">{new Set(tickets.map(t => t.teacherId)).size}</div></div>
            </div>
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-4 bg-purple-100 rounded-full text-purple-600"><PieChart className="w-8 h-8" /></div>
              <div>
                <div className="text-sm text-gray-500 font-medium">Top Reason</div>
                <div className="text-xl font-bold">
                  {Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || '-'}
                </div>
              </div>
            </div>
          </div>

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
