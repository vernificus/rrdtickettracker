import React, { useState, useEffect, useMemo } from 'react';
import {
  Ticket, Users, Shield, Palette, Download,
  Award, PieChart, ChevronLeft, CheckCircle2, X
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAnalytics } from 'firebase/analytics';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore, collection, doc, setDoc, onSnapshot,
  addDoc, serverTimestamp, writeBatch
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
  const [loading, setLoading] = useState(true);

  // Data State
  const [tickets, setTickets] = useState([]);
  const [students, setStudents] = useState([]);
  const [profiles, setProfiles] = useState([]);

  // UI State
  const [toast, setToast] = useState({ visible: false, message: '' });

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

    const unsubProfiles = onSnapshot(profilesRef, (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setProfiles(data);
      const myProfile = data.find(p => p.id === user.uid);
      setProfile(myProfile || null);
      if (snap.metadata.fromCache === false) setLoading(false);
    });

    const unsubTickets = onSnapshot(ticketsRef, (snap) => {
      setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubStudents = onSnapshot(studentsRef, (snap) => {
      setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    return () => { unsubProfiles(); unsubTickets(); unsubStudents(); };
  }, [user]);

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
          <AdminDashboard tickets={tickets} students={students} profiles={profiles} showToast={showToast} />
        )}
        {profile.role === 'homeroom' && (
          <HomeroomDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} />
        )}
        {profile.role === 'specialist' && (
          <SpecialistDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={user} />
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid), {
        name, role, customStudents: [], createdAt: serverTimestamp()
      });
      onComplete();
    } catch (err) { console.error(err); }
  };

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
            <label className="block text-sm font-medium text-gray-700 mb-1">Your Full Name (e.g. Mr. Smith)</label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)} className="w-full border-gray-300 rounded-lg p-3 border focus:ring-green-500 focus:border-green-500" placeholder="Mr. Smith" />
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
          <button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl transition">
            Save & Continue
          </button>
        </form>
      </div>
    </div>
  );
}

// --- Homeroom Dashboard ---
function HomeroomDashboard({ profile, students, tickets, showToast, user }) {
  const [modalData, setModalData] = useState(null);

  const myStudents = useMemo(() => {
    const central = students.filter(s => s.homeroom === profile.name).map(s => s.name);
    const custom = profile.customStudents || [];
    return [...new Set([...central, ...custom])].sort();
  }, [students, profile]);

  const myTickets = tickets.filter(t => t.teacherId === user.uid);
  const ticketCounts = {};
  myStudents.forEach(s => ticketCounts[s] = 0);
  myTickets.forEach(t => { if (ticketCounts[t.recipient] !== undefined) ticketCounts[t.recipient]++; });

  const handleGiveTicket = async (reason) => {
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid,
        teacherName: profile.name,
        recipient: modalData.recipient,
        recipientType: modalData.type,
        reason,
        timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${modalData.recipient}!`);
      setModalData(null);
    } catch (e) { showToast("Error saving ticket."); }
  };

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

      {myStudents.length === 0 ? (
        <div className="bg-white p-8 rounded-xl border text-center text-gray-500">
          <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p>No students assigned to &quot;{profile.name}&quot;.</p>
          <p className="text-sm mt-1">Admins can upload the central roster, or you can add custom students in settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {myStudents.map(student => (
            <button key={student} onClick={() => setModalData({ recipient: student, type: 'student' })}
              className="bg-white p-5 rounded-xl shadow-sm border border-gray-200 hover:border-green-500 hover:shadow-md transition text-left flex flex-col justify-between h-28 group">
              <span className="font-bold text-gray-800 leading-tight group-hover:text-green-700">{student}</span>
              <div className="flex items-center justify-between w-full mt-2">
                <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Tickets</span>
                <span className="bg-green-50 text-green-700 py-1 px-3 rounded-full font-black text-sm">{ticketCounts[student]}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} />}
    </div>
  );
}

// --- Specialist Dashboard (Nested View) ---
function SpecialistDashboard({ profile, students, tickets, showToast, user }) {
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

  const handleGiveTicket = async (reason) => {
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'tickets'), {
        teacherId: user.uid,
        teacherName: profile.name,
        recipient: modalData.recipient,
        recipientType: modalData.type,
        reason,
        timestamp: serverTimestamp()
      });
      showToast(`Ticket awarded to ${modalData.recipient}!`);
      setModalData(null);
    } catch (e) { showToast("Error saving ticket."); }
  };

  return (
    <div className="space-y-6">
      {!selectedClass ? (
        <>
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900">School Classes</h1>
            <p className="text-gray-500">Select a class to award a whole-class ticket or individual students.</p>
          </div>
          {classes.length === 0 ? (
            <div className="bg-white p-8 text-center rounded-xl border text-gray-500">No classes found in the central roster. Admin needs to upload CSV.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {classes.map(cls => (
                <button key={cls} onClick={() => setSelectedClass(cls)} className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 hover:border-green-500 transition flex items-center justify-between group">
                  <div className="flex items-center gap-4">
                    <div className="bg-blue-50 p-3 rounded-lg text-blue-600 group-hover:bg-blue-100"><Users className="w-6 h-6" /></div>
                    <div className="text-left"><div className="font-bold text-lg text-gray-800">{cls}</div><div className="text-sm text-gray-500">View Roster</div></div>
                  </div>
                </button>
              ))}
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
          <div className="bg-gradient-to-r from-green-500 to-green-600 p-6 rounded-2xl shadow-sm mb-8 text-white flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold">Class-Wide Recognition</h3>
              <p className="text-green-100 text-sm">Award a ticket to the entire class as a unit.</p>
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
                <button key={student} onClick={() => setModalData({ recipient: student, type: 'student' })} className="bg-white p-5 rounded-xl shadow-sm border border-gray-200 hover:border-blue-500 hover:shadow-md transition text-left h-24 flex items-center">
                  <span className="font-bold text-gray-800 leading-tight">{student}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} />}
    </div>
  );
}

// --- Admin Dashboard (Includes CSV Upload) ---
function AdminDashboard({ tickets, students, profiles, showToast }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [csvText, setCsvText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const reasons = { Respectful: 0, Responsible: 0, Determined: 0 };
  tickets.forEach(t => { if (reasons[t.reason] !== undefined) reasons[t.reason]++; });

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 border-b pb-4">
        <h1 className="text-3xl font-bold text-gray-900">Admin Controls</h1>
        <div className="flex bg-gray-200 p-1 rounded-lg">
          <button onClick={() => setActiveTab('overview')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'overview' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Overview</button>
          <button onClick={() => setActiveTab('roster')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'roster' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Roster Sync (CSV)</button>
        </div>
      </div>

      {activeTab === 'overview' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4">
              <div className="p-4 bg-green-100 rounded-full text-green-600"><Award className="w-8 h-8" /></div>
              <div><div className="text-sm text-gray-500 font-medium">Total Tickets</div><div className="text-3xl font-bold">{tickets.length}</div></div>
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
            <div className="px-6 py-4 border-b bg-gray-50"><h3 className="font-bold text-gray-800">Recent Activity</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-600">
                <thead className="bg-gray-50 border-b">
                  <tr><th className="px-6 py-3">Time</th><th className="px-6 py-3">Teacher</th><th className="px-6 py-3">Recipient</th><th className="px-6 py-3">Reason</th></tr>
                </thead>
                <tbody className="divide-y">
                  {[...tickets].sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0)).slice(0, 10).map(t => (
                    <tr key={t.id}>
                      <td className="px-6 py-3">{t.timestamp ? t.timestamp.toDate().toLocaleString() : 'Now'}</td>
                      <td className="px-6 py-3 font-medium text-gray-900">{t.teacherName}</td>
                      <td className="px-6 py-3">{t.recipient} {t.recipientType === 'class' && '(Class)'}</td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-bold ${t.reason === 'Respectful' ? 'bg-blue-100 text-blue-800' : t.reason === 'Responsible' ? 'bg-amber-100 text-amber-800' : 'bg-purple-100 text-purple-800'}`}>{t.reason}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <p className="text-gray-600">Total Students in Database: <strong>{students.length}</strong></p>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Shared Modals ---
function GiveTicketModal({ data, onClose, onSelect }) {
  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="p-6 text-center">
          <div className="flex justify-end mb-2">
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-6 h-6" /></button>
          </div>
          <h3 className="text-gray-500 font-semibold uppercase tracking-wider text-sm mb-1">Award Ticket To</h3>
          <p className="text-2xl font-black text-gray-900 mb-8">{data.recipient}</p>

          <div className="space-y-3">
            <button onClick={() => onSelect('Respectful')} className="w-full py-4 px-6 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl font-bold text-lg border-2 border-blue-200 hover:border-blue-400 transition-all text-left flex justify-between">
              Respectful <span className="text-blue-400">&#x1F91D;</span>
            </button>
            <button onClick={() => onSelect('Responsible')} className="w-full py-4 px-6 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-xl font-bold text-lg border-2 border-amber-200 hover:border-amber-400 transition-all text-left flex justify-between">
              Responsible <span className="text-amber-400">&#x1F4CB;</span>
            </button>
            <button onClick={() => onSelect('Determined')} className="w-full py-4 px-6 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-xl font-bold text-lg border-2 border-purple-200 hover:border-purple-400 transition-all text-left flex justify-between">
              Determined <span className="text-purple-400">&#x1F525;</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
