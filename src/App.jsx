import React, { useState, useEffect, useMemo } from 'react';
import {
  Ticket, Users, Shield, Palette, Download, LogOut,
  Award, PieChart, ChevronLeft, CheckCircle2, X, AlertTriangle, Trash2, Star, Search,
  Crown, BarChart3, TrendingUp, GitMerge, ArrowRight, Lock, Plus, HelpCircle, Settings, Gamepad2, Tv
} from 'lucide-react';

const API_URL = import.meta.env.DEV ? 'http://localhost:8080' : '';

const api = {
  token: localStorage.getItem('token'),
  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  },
  async fetch(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `API error (${res.status})`);
    }
    return res.json();
  }
};

// --- Mock Firestore Layer for compatibility with existing dashboards ---
const db = {}; // dummy

const collection = (db, ...paths) => {
  return { type: 'collection', path: paths[paths.length - 1] };
};

const doc = (dbOrColl, ...paths) => {
  if (dbOrColl && dbOrColl.type === 'collection') {
    const id = paths[0] || Math.random().toString(36).substring(2);
    return { collection: dbOrColl.path, id };
  }
  const isDocReference = paths.length === 2 && typeof paths[0] === 'string';
  if (isDocReference) {
    return { collection: paths[0], id: paths[1] };
  }
  const collectionName = paths.length >= 2 ? paths[paths.length - 2] : dbOrColl;
  const id = paths.length >= 1 ? paths[paths.length - 1] : Math.random().toString(36).substring(2);
  return { collection: collectionName, id };
};

const addDoc = async (collOrName, data) => {
  const collName = typeof collOrName === 'object' && collOrName.path ? collOrName.path : collOrName;
  const payload = { ...data };
  if (payload.timestamp && typeof payload.timestamp === 'object') {
    payload.timestamp = new Date().toISOString();
  }
  const endpointMap = {
    'tickets': '/api/tickets',
    'goldenTickets': '/api/golden-tickets',
    'spending': '/api/spending'
  };
  const url = endpointMap[collName] || `/api/${collName}`;
  const result = await api.fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (window.triggerRefresh) window.triggerRefresh();
  return { id: result.id };
};

const deleteDoc = async (docRef) => {
  const collName = docRef.collection;
  const id = docRef.id;
  const endpointMap = {
    'tickets': `/api/tickets/${id}`,
    'goldenTickets': `/api/golden-tickets/${id}`,
    'spending': `/api/spending/${id}`,
    'users': `/api/teachers/${id}`
  };
  const url = endpointMap[collName] || `/api/${collName}/${id}`;
  await api.fetch(url, {
    method: 'DELETE'
  });
  if (window.triggerRefresh) window.triggerRefresh();
};

const setDoc = async (docRef, data) => {
  const url = `/api/${docRef.collection}/${docRef.id}`;
  await api.fetch(url, {
    method: 'POST',
    body: JSON.stringify(data)
  });
  if (window.triggerRefresh) window.triggerRefresh();
};

const writeBatch = () => {
  const operations = [];
  return {
    set(docRef, data) {
      operations.push({ type: 'set', docRef, data });
    },
    delete(docRef) {
      operations.push({ type: 'delete', docRef });
    },
    async commit() {
      const isDeleteStudents = operations.every(op => op.type === 'delete' && op.docRef.collection === 'students');
      if (isDeleteStudents && operations.length > 0) {
        await api.fetch('/api/roster/clear', { method: 'POST' });
        if (window.triggerRefresh) window.triggerRefresh();
        return;
      }

      const isUploadRoster = operations.every(op => op.type === 'set' && op.docRef.collection === 'students');
      if (isUploadRoster && operations.length > 0) {
        const studentList = operations.map(op => ({
          name: op.data.name,
          homeroom: op.data.homeroom,
          grade: op.data.grade || 'N/A'
        }));
        await api.fetch('/api/roster/upload', {
          method: 'POST',
          body: JSON.stringify({ students: studentList })
        });
        if (window.triggerRefresh) window.triggerRefresh();
        return;
      }

      const deleteOp = operations.find(op => op.type === 'delete' && op.docRef.collection === 'students');
      const setOp = operations.find(op => op.type === 'set' && op.docRef.collection === 'tickets');
      if (deleteOp && setOp) {
        const sourceName = deleteOp.docRef.id;
        const targetName = setOp.data.recipient;
        await api.fetch('/api/roster/merge', {
          method: 'POST',
          body: JSON.stringify({ sourceName, targetName })
        });
        if (window.triggerRefresh) window.triggerRefresh();
        return;
      }
    }
  };
};

const serverTimestamp = () => {
  return new Date().toISOString();
};

// --- Helper to convert ISO dates into Firestore-like Timestamp objects ---
const formatTicket = (t) => {
  const date = t.timestamp ? new Date(t.timestamp) : new Date();
  return {
    ...t,
    timestamp: {
      toDate: () => date,
      toMillis: () => date.getTime()
    }
  };
};

// --- Main App Component ---
export default function App() {
  const [profile, setProfile] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Teacher Data State
  const [tickets, setTickets] = useState([]);
  const [students, setStudents] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [goldenTickets, setGoldenTickets] = useState([]);
  const [spending, setSpending] = useState([]);
  const [classGoals, setClassGoals] = useState([]);
  const [gradeGoals, setGradeGoals] = useState([]);
  const [balances, setBalances] = useState({});

  // Student Data State
  const [studentData, setStudentData] = useState(null);

  // UI State
  const [toast, setToast] = useState({ visible: false, message: '' });

  // Role Switching Modal State
  const [showRoleSwitch, setShowRoleSwitch] = useState(false);
  const [newRole, setNewRole] = useState(role || 'homeroom');
  const [roleAdminPassword, setRoleAdminPassword] = useState('');
  const [roleChangeLoading, setRoleChangeLoading] = useState(false);

  // Help Modal State
  const [showHelp, setShowHelp] = useState(false);

  // Attendance & Student Modals & View States
  const [absentStudents, setAbsentStudents] = useState(new Set());
  const [editStudentData, setEditStudentData] = useState(null);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [activeView, setActiveView] = useState('dashboard'); // 'dashboard' or 'raffle'
  const [studentsToPrint, setStudentsToPrint] = useState(null);

  // Expose triggerRefresh globally for the mock Firestore operations
  useEffect(() => {
    window.triggerRefresh = () => {
      setRefreshTrigger(prev => prev + 1);
    };
    return () => {
      delete window.triggerRefresh;
    };
  }, []);

  const showToast = (message) => {
    setToast({ visible: true, message });
    setTimeout(() => setToast({ visible: false, message: '' }), 3000);
  };

  // 1. Initial Load & Auth Check
  useEffect(() => {
    const loadInitialData = async () => {
      if (!api.token) {
        setLoading(false);
        return;
      }
      try {
        if (!profile) {
          setLoading(true);
        }
        const data = await api.fetch('/api/initial-data');
        setProfile(data.profile);
        setRole(data.role);
        if (data.role === 'student') {
          setStudentData(data);
        } else {
          setProfiles(data.profiles || []);
          setStudents(data.students || []);
          setTickets((data.tickets || []).map(formatTicket));
          setGoldenTickets((data.goldenTickets || []).map(formatTicket));
          setSpending(data.spending || []);
          setClassGoals(data.classGoals || []);
          setGradeGoals(data.gradeGoals || []);
          setBalances(data.balances || {});
        }
      } catch (e) {
        console.error("Session expired or invalid:", e);
        api.setToken(null);
        setProfile(null);
        setRole(null);
      } finally {
        setLoading(false);
      }
    };
    loadInitialData();
  }, [refreshTrigger]);

  const handleSignOut = () => {
    api.setToken(null);
    setProfile(null);
    setRole(null);
    setStudentData(null);
    showToast("Signed out successfully");
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
    return <Login onLoginSuccess={(prof, token) => {
      api.setToken(token);
      setProfile(prof);
      setRole(prof.role);
      setRefreshTrigger(prev => prev + 1);
    }} showToast={showToast} />;
  }

  if (role === 'student' && studentData) {
    return <StudentDashboard studentData={studentData} onSignOut={handleSignOut} />;
  }

  // Calculate myUids for ticket filter mapping
  const myUids = new Set([profile.email]); // email is primary teacher ID
  profiles.forEach(p => {
    if (p.linkedTo === profile.email) myUids.add(p.email);
  });

  const handleRoleChange = async () => {
    if (!newRole) return;
    setRoleChangeLoading(true);
    try {
      const data = await api.fetch('/api/auth/change-role', {
        method: 'POST',
        body: JSON.stringify({ newRole, adminPassword: newRole === 'admin' ? roleAdminPassword : undefined })
      });
      api.setToken(data.token);
      setProfile(data.profile);
      setRole(data.profile.role);
      setShowRoleSwitch(false);
      setRoleAdminPassword('');
      setRefreshTrigger(prev => prev + 1);
      showToast(`Role changed to ${newRole}!`);
    } catch (e) {
      showToast(e.message || 'Failed to change role.');
    } finally {
      setRoleChangeLoading(false);
    }
  };

  const handleToggleAbsent = (name) => {
    setAbsentStudents(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans text-gray-800">
      <Navbar profile={profile} tickets={tickets} onSignOut={handleSignOut} onRoleSwitch={() => { setNewRole(role); setShowRoleSwitch(true); }} onHelp={() => setShowHelp(true)} activeView={activeView} setActiveView={setActiveView} onChangePassword={() => setShowChangePassword(true)} />

      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        {activeView === 'raffle' ? (
          <RaffleDashboard tickets={tickets} students={students} profiles={profiles} showToast={showToast} />
        ) : (
          <>
            {role === 'admin' && (
              <AdminDashboard tickets={tickets} students={students} profiles={profiles} showToast={showToast} user={{ uid: profile.email }} effectiveUid={profile.email} profile={profile} goldenTickets={goldenTickets} myUids={myUids} balances={balances} spending={spending} gradeGoals={gradeGoals} classGoals={classGoals} absentStudents={absentStudents} onToggleAbsent={handleToggleAbsent} onEditStudent={setEditStudentData} onPrintLoginCards={setStudentsToPrint} />
            )}
            {role === 'homeroom' && (
              <HomeroomDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={{ uid: profile.email }} effectiveUid={profile.email} goldenTickets={goldenTickets} myUids={myUids} classGoals={classGoals} setClassGoals={setClassGoals} spending={spending} balances={balances} absentStudents={absentStudents} onToggleAbsent={handleToggleAbsent} onEditStudent={setEditStudentData} onPrintLoginCards={setStudentsToPrint} />
            )}
            {role === 'specialist' && (
              <SpecialistDashboard profile={profile} students={students} tickets={tickets} showToast={showToast} user={{ uid: profile.email }} effectiveUid={profile.email} goldenTickets={goldenTickets} myUids={myUids} balances={balances} classGoals={classGoals} spending={spending} absentStudents={absentStudents} onToggleAbsent={handleToggleAbsent} onEditStudent={setEditStudentData} onPrintLoginCards={setStudentsToPrint} />
            )}
          </>
        )}
      </main>

      {/* Role Switch Modal */}
      {showRoleSwitch && (
        <div className="fixed inset-0 bg-navy-950/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full border border-gray-150 shadow-xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-display font-black text-navy-950 text-base flex items-center gap-2"><Settings className="w-5 h-5 text-gray-400" /> Change Role</h3>
              <button onClick={() => setShowRoleSwitch(false)} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-500">Current role: <span className="font-bold text-navy-950 capitalize">{role}</span></p>
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">New Role</label>
              <select value={newRole} onChange={e => setNewRole(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none bg-white">
                <option value="homeroom">Homeroom Teacher</option>
                <option value="specialist">Specialist</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            {newRole === 'admin' && (
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Admin Password Required</label>
                <input type="password" value={roleAdminPassword} onChange={e => setRoleAdminPassword(e.target.value)} placeholder="Enter admin password" className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button type="button" onClick={() => setShowRoleSwitch(false)} className="px-4 py-2 border rounded-xl text-sm font-bold text-gray-600 bg-white">Cancel</button>
              <button onClick={handleRoleChange} disabled={roleChangeLoading || newRole === role} className="px-4 py-2 border rounded-xl text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">{roleChangeLoading ? 'Changing...' : 'Switch Role'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Student Modal */}
      {editStudentData && (
        <EditStudentModal student={editStudentData} onClose={() => setEditStudentData(null)} showToast={showToast} />
      )}

      {/* Change Password Modal */}
      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} showToast={showToast} />
      )}

      {/* Help Modal */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {studentsToPrint && <PrintableLoginCards students={studentsToPrint} onClose={() => setStudentsToPrint(null)} />}

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
function StudentTicketCard({ student, onGiveTicket, isSubmitting, submittingFor, balances, onSpend, students = [], onEditStudent, isAbsent, onToggleAbsent, tickets = [], teacherEmail }) {
  const bal = balances[student] || { earned: 0, spent: 0, Respectful: 0, Responsible: 0, Determined: 0 };
  const spendable = Math.max(0, bal.earned - bal.spent);
  const isBusy = isSubmitting && submittingFor === student;
  
  const studentObj = students.find(s => s.name === student);

  // Calculate only tickets given by THIS teacher (if teacherEmail is provided)
  const teacherCounts = useMemo(() => {
    const counts = { Respectful: 0, Responsible: 0, Determined: 0 };
    if (!teacherEmail) {
      return {
        Respectful: bal.Respectful || 0,
        Responsible: bal.Responsible || 0,
        Determined: bal.Determined || 0
      };
    }
    tickets.forEach(t => {
      if (t.recipient === student && t.recipientType === 'student' && t.teacherEmail && t.teacherEmail.toLowerCase() === teacherEmail.toLowerCase()) {
        if (counts[t.reason] !== undefined) {
          counts[t.reason]++;
        }
      }
    });
    return counts;
  }, [tickets, student, teacherEmail, bal]);

  const earned = teacherCounts.Respectful + teacherCounts.Responsible + teacherCounts.Determined;

  return (
    <div className={`bg-white rounded-3xl p-4 border shadow-sm flex flex-col justify-between space-y-3 hover:shadow-md transition duration-200 ${isAbsent ? 'opacity-55 border-red-200 bg-red-50/20' : 'border-gray-150'}`}>
      {/* Header */}
      <div className="flex justify-between items-start gap-1">
        <div className="min-w-0">
          <span className="font-display font-black text-navy-950 text-base leading-tight block" title={student}>{student}</span>
          {studentObj && (
            <span className="text-[10px] text-gray-400 block truncate">
              ID: {studentObj.id}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {studentObj && onEditStudent && (
            <button
              onClick={() => onEditStudent(studentObj)}
              aria-label="Edit Student"
              type="button"
              className="text-gray-400 hover:text-navy-955 p-1 rounded-lg hover:bg-gray-100 transition"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
          {onToggleAbsent && (
            <button
              onClick={onToggleAbsent}
              type="button"
              className={`px-1.5 py-0.5 rounded text-[9px] font-black tracking-wider uppercase transition ${isAbsent ? 'bg-red-100 text-red-750 border border-red-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              {isAbsent ? 'Absent' : 'Present'}
            </button>
          )}
        </div>
      </div>

      {/* Middle Stats Pill Container */}
      <div className="bg-slate-50 border border-slate-100 p-2.5 rounded-2xl flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-1">
          {/* Spendable Group */}
          <div className="flex items-center gap-1.5">
            <div className="w-7 h-7 bg-brand-700 text-white rounded-full flex items-center justify-center font-black text-sm shadow-inner">
              {spendable}
            </div>
            <div className="text-left">
              <div className="text-[9px] font-bold text-gray-400 uppercase leading-none">Spendable</div>
              <button
                onClick={() => onSpend && onSpend(student, spendable)}
                disabled={spendable < 1 || isAbsent}
                type="button"
                className="text-brand-700 font-bold hover:underline text-[10px] disabled:opacity-40 disabled:no-underline text-left block leading-tight"
              >
                Spend
              </button>
            </div>
          </div>

          {/* Earned Summary */}
          <div className="text-right">
            <div className="text-[9px] font-bold text-gray-400 uppercase mb-0.5">Earned: {earned}</div>
            <div className="flex items-center gap-0.5 justify-end">
              <span className="text-[9px] font-bold bg-blue-50 border border-blue-100 text-blue-700 px-1 py-0.5 rounded-sm" title="Respectful">R:{teacherCounts.Respectful}</span>
              <span className="text-[9px] font-bold bg-amber-50 border border-amber-100 text-amber-700 px-1 py-0.5 rounded-sm" title="Responsible">S:{teacherCounts.Responsible}</span>
              <span className="text-[9px] font-bold bg-purple-50 border border-purple-100 text-purple-700 px-1 py-0.5 rounded-sm" title="Determined">D:{teacherCounts.Determined}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Roster Give Tickets Buttons */}
      <div className="flex flex-col gap-1">
        <button
          disabled={isBusy || isAbsent}
          onClick={() => onGiveTicket(student, 'Respectful')}
          type="button"
          className="w-full py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800 rounded-xl font-bold text-[11px] transition disabled:opacity-40"
        >
          {isBusy ? '...' : 'Respectful Ticket'}
        </button>
        <button
          disabled={isBusy || isAbsent}
          onClick={() => onGiveTicket(student, 'Responsible')}
          type="button"
          className="w-full py-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 rounded-xl font-bold text-[11px] transition disabled:opacity-40"
        >
          {isBusy ? '...' : 'Responsible Ticket'}
        </button>
        <button
          disabled={isBusy || isAbsent}
          onClick={() => onGiveTicket(student, 'Determined')}
          type="button"
          className="w-full py-1.5 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-800 rounded-xl font-bold text-[11px] transition disabled:opacity-40"
        >
          {isBusy ? '...' : 'Determined Ticket'}
        </button>
      </div>
    </div>
  );
}

// --- Spend Points Modal ---
function SpendPointsModal({ student, spendable, onClose, showToast }) {
  const [amount, setAmount] = useState(1);
  const [item, setItem] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (amount < 1 || amount > spendable) {
      showToast(`Invalid amount. Student only has ${spendable} spendable tickets.`);
      return;
    }
    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'spending'), {
        recipient: student,
        amount: Number(amount),
        item: item.trim() || 'Class Store Reward',
        timestamp: serverTimestamp()
      });
      showToast(`Successfully redeemed ${amount} tickets for ${student}!`);
      onClose();
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (err) {
      console.error(err);
      showToast("Error redeeming tickets.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-navy-950/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-3xl p-6 max-w-sm w-full border border-gray-100 shadow-xl space-y-4">
        <div className="flex justify-between items-center border-b pb-3">
          <h3 className="font-display font-black text-navy-950 text-base">Redeem Tickets for {student}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="spend-amount" className="block text-xs font-bold text-gray-500 mb-1">Tickets to Deduct (Spendable: {spendable})</label>
            <input
              id="spend-amount"
              type="number"
              min="1"
              max={spendable}
              required
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none text-navy-950"
            />
          </div>
          <div>
            <label htmlFor="spend-item" className="block text-xs font-bold text-gray-500 mb-1">Reward Item / Reason</label>
            <input
              id="spend-item"
              type="text"
              placeholder="e.g. Sit at teacher's desk"
              value={item}
              onChange={e => setItem(e.target.value)}
              className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none text-navy-950"
            />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border rounded-xl text-sm font-bold text-gray-600 bg-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || spendable < 1}
              className="px-4 py-2 border rounded-xl text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Processing...' : 'Confirm Spend'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Class Display Mode (Projector/Fullscreen View) ---
function ClassDisplayMode({ className, students, balances, classGoals = [], isSubmitting, handleGiveTicketDirect, onClose }) {
  const [hideBalances, setHideBalances] = useState(false);
  const [activeDisplayStudent, setActiveDisplayStudent] = useState(null);

  const myStudents = useMemo(() => {
    return [...students].sort();
  }, [students]);

  const currentGoal = useMemo(() => {
    return classGoals.find(g => g.className === className);
  }, [classGoals, className]);

  const goalTarget = currentGoal?.goalTickets || 50;
  const rewardText = currentGoal?.rewardText || 'Pajama Party';

  const classTicketsEarned = useMemo(() => {
    return myStudents.reduce((sum, studentName) => sum + (balances[studentName]?.earned || 0), 0);
  }, [myStudents, balances]);

  const goalProgress = Math.min(100, Math.round((classTicketsEarned / goalTarget) * 100));

  // Find highest earner for crown calculation
  let maxTickets = 0;
  let topEarner = '';
  myStudents.forEach(student => {
    const bal = balances[student] || { earned: 0 };
    if (bal.earned > maxTickets) {
      maxTickets = bal.earned;
      topEarner = student;
    }
  });

  return (
    <div className="fixed inset-0 bg-[#0b3c29] text-white flex flex-col font-sans z-50 p-4 pb-6 overflow-hidden animate-fade-in text-navy-950">
      {/* Display Mode Header Banner */}
      <header className="bg-[#05281a] border-b border-[#0f4630] px-6 py-3 flex justify-between items-center rounded-t-3xl text-white flex-shrink-0">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight font-display text-white">
            {className}&apos;s Roadrunners
          </h1>
          <p className="text-[#a3d9c1] text-[10px]">Tap a student to award a ticket!</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setHideBalances(!hideBalances)}
            className="flex items-center gap-1.5 border border-white/20 hover:bg-white/10 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition cursor-pointer"
          >
            {hideBalances ? 'Show Balances' : 'Hide Balances'}
          </button>

          <button
            onClick={onClose}
            className="flex items-center gap-1.5 border border-white/20 hover:bg-white/10 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            Exit
          </button>
        </div>
      </header>

      {/* Compact Class Goal Card */}
      <div className="max-w-7xl mx-auto w-full px-6 pt-3 flex-shrink-0">
        <div className="bg-white border border-gray-150 p-3 rounded-xl shadow-xs flex items-center justify-between text-navy-950">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center text-brand-700">
              <Star className="w-4 h-4 fill-current" />
            </div>
            <div>
              <h3 className="font-display font-black text-brand-800 text-sm">Class Goal: {rewardText}</h3>
              <div className="w-32 bg-gray-100 rounded-full h-1.5 overflow-hidden mt-1">
                <div className="bg-brand-500 h-full rounded-full transition-all duration-500" style={{ width: `${goalProgress}%` }} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-brand-700 font-black uppercase tracking-wider">{goalProgress}%</span>
            <div className="font-display font-black text-brand-800 text-base">
              {classTicketsEarned} / {goalTarget}
            </div>
          </div>
        </div>
      </div>

      {/* Roster Grid (Responsive, Auto-Fit, Horizontal Layout) */}
      <div className="flex-1 max-w-7xl mx-auto w-full p-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5 content-start overflow-y-auto mt-4 pb-4">
        {myStudents.map(student => {
          const bal = balances[student] || { earned: 0, spent: 0 };
          const spendable = Math.max(0, bal.earned - bal.spent);
          const isTop = student === topEarner && maxTickets > 0;
          return (
            <button
              key={student}
              onClick={() => setActiveDisplayStudent(student)}
              className="bg-white border border-gray-150 rounded-xl shadow-xs hover:shadow-sm transition duration-150 relative flex items-center justify-between px-4 py-2.5 cursor-pointer group text-navy-950"
            >
              <div className="flex items-center gap-2 min-w-0 pr-2">
                {isTop && (
                  <div className="bg-yellow-400 text-amber-955 p-1 rounded-lg flex-shrink-0">
                    <Crown className="w-3.5 h-3.5 fill-current text-amber-955" />
                  </div>
                )}
                
                <span className="font-display font-black text-navy-950 text-left group-hover:text-brand-600 transition leading-tight text-sm truncate" title={student}>
                  {student}
                </span>
              </div>

              <div className="w-10 h-10 bg-brand-700 text-white rounded-full flex items-center justify-center font-black text-base shadow-inner border-2 border-brand-100 flex-shrink-0">
                {hideBalances ? '?' : spendable}
              </div>
            </button>
          );
        })}
      </div>

      {/* Display Mode Award Modal */}
      {activeDisplayStudent && (
        <div className="fixed inset-0 bg-navy-950/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in text-navy-950">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full border border-gray-100 shadow-2xl flex flex-col items-center space-y-6">
            <div className="text-center">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1">
                AWARD A GREEN TICKET TO
              </span>
              <h2 className="text-4xl font-display font-black text-navy-950">
                {activeDisplayStudent}
              </h2>
            </div>

            <div className="w-full flex flex-col gap-3">
              <button
                disabled={isSubmitting}
                onClick={async () => {
                  await handleGiveTicketDirect(activeDisplayStudent, 'Respectful');
                  setActiveDisplayStudent(null);
                }}
                className="w-full py-4 border border-blue-200 text-blue-700 bg-blue-50/50 hover:bg-blue-50 text-xl font-bold rounded-2xl transition disabled:opacity-50 cursor-pointer"
              >
                Respectful
              </button>
              <button
                disabled={isSubmitting}
                onClick={async () => {
                  await handleGiveTicketDirect(activeDisplayStudent, 'Responsible');
                  setActiveDisplayStudent(null);
                }}
                className="w-full py-4 border border-amber-200 text-amber-700 bg-amber-50/50 hover:bg-amber-50 text-xl font-bold rounded-2xl transition disabled:opacity-50 cursor-pointer"
              >
                Responsible
              </button>
              <button
                disabled={isSubmitting}
                onClick={async () => {
                  await handleGiveTicketDirect(activeDisplayStudent, 'Determined');
                  setActiveDisplayStudent(null);
                }}
                className="w-full py-4 border border-purple-200 text-purple-700 bg-purple-50/50 hover:bg-purple-50 text-xl font-bold rounded-2xl transition disabled:opacity-50 cursor-pointer"
              >
                Determined
              </button>
            </div>

            <button
              onClick={() => setActiveDisplayStudent(null)}
              className="text-gray-400 hover:text-gray-700 font-bold text-sm pt-2 cursor-pointer border-none outline-none bg-transparent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Weekly Raffle Component ---
function RaffleDashboard({ tickets, students, profiles, showToast }) {
  const [targetType, setTargetType] = useState('student'); // 'student' or 'teacher'
  const [timeRange, setTimeRange] = useState('week'); // 'week', 'month', 'all'
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedHomeroom, setSelectedHomeroom] = useState('');

  // Raffle animation states
  const [isDrawing, setIsDrawing] = useState(false);
  const [winner, setWinner] = useState(null);
  const [tickerName, setTickerName] = useState('');
  const [showConfetti, setShowConfetti] = useState(false);

  // Filter candidates based on ticket history
  const candidates = useMemo(() => {
    const now = new Date();
    let cutoff = new Date(0); // all time
    if (timeRange === 'week') {
      cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (timeRange === 'month') {
      cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    const eligibleTickets = tickets.filter(t => {
      const ticketTime = t.timestamp ? new Date(t.timestamp.toDate()) : new Date();
      return ticketTime >= cutoff;
    });

    if (targetType === 'student') {
      // Group by student
      const counts = {};
      eligibleTickets.forEach(t => {
        if (t.recipientType === 'student') {
          counts[t.recipient] = (counts[t.recipient] || 0) + 1;
        }
      });

      // Filter by homeroom and grade if requested
      return Object.entries(counts)
        .map(([name, count]) => {
          const studentObj = students.find(s => s.name === name);
          return {
            name,
            count,
            homeroom: studentObj?.homeroom || 'Unknown',
            grade: studentObj?.grade || 'Unknown'
          };
        })
        .filter(c => {
          if (selectedGrade && c.grade !== selectedGrade) return false;
          if (selectedHomeroom && c.homeroom !== selectedHomeroom) return false;
          return true;
        });
    } else {
      // Group by teacher
      const counts = {};
      eligibleTickets.forEach(t => {
        counts[t.teacherName] = (counts[t.teacherName] || 0) + 1;
      });

      return Object.entries(counts).map(([name, count]) => ({
        name,
        count
      }));
    }
  }, [tickets, students, targetType, timeRange, selectedGrade, selectedHomeroom]);

  const totalTickets = useMemo(() => {
    return candidates.reduce((sum, c) => sum + c.count, 0);
  }, [candidates]);

  // List of all candidate grades & homerooms for dropdowns
  const grades = useMemo(() => [...new Set(students.map(s => s.grade).filter(Boolean))].sort(), [students]);
  const homerooms = useMemo(() => [...new Set(students.map(s => s.homeroom).filter(Boolean))].sort(), [students]);

  const handleDraw = () => {
    if (candidates.length === 0) {
      showToast("No eligible candidates in this pool!");
      return;
    }
    setIsDrawing(true);
    setWinner(null);
    setShowConfetti(false);

    // Create the lottery pool (weighted by ticket counts)
    const pool = [];
    candidates.forEach(c => {
      for (let i = 0; i < c.count; i++) {
        pool.push(c.name);
      }
    });

    // Run custom ticker animation
    let duration = 4000; // 4 seconds total animation
    let start = Date.now();
    let speed = 40; // start fast (every 40ms change name)

    const tick = () => {
      const elapsed = Date.now() - start;
      if (elapsed >= duration) {
        // Finished! Pick final winner
        const finalWinnerName = pool[Math.floor(Math.random() * pool.length)];
        const finalWinner = candidates.find(c => c.name === finalWinnerName);
        setWinner(finalWinner);
        setTickerName(finalWinner.name);
        setIsDrawing(false);
        setShowConfetti(true);
        // Turn off confetti after 8 seconds
        setTimeout(() => setShowConfetti(false), 8000);
      } else {
        // Cycle names
        const randomCandidate = candidates[Math.floor(Math.random() * candidates.length)];
        setTickerName(randomCandidate.name);
        
        // Decelerate speed
        const progress = elapsed / duration;
        speed = 40 + Math.pow(progress, 2.5) * 500; // curves from 40ms to 540ms
        setTimeout(tick, speed);
      }
    };

    tick();
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto relative">
      {showConfetti && <ConfettiEffect />}

      <div className="bg-white p-6 rounded-3xl border border-gray-155 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-navy-950 font-display flex items-center gap-2">
            <Star className="w-8 h-8 text-yellow-500 fill-current animate-spin-slow" />
            <span>Weekly Raffle Drum</span>
          </h1>
          <p className="text-sm text-gray-500 mt-1">Reward students and teachers who earned tickets during the selected time period.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setTargetType('student'); setWinner(null); }}
            className={`px-4 py-2 text-sm font-bold rounded-xl transition ${targetType === 'student' ? 'bg-brand-700 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            Student Raffle
          </button>
          <button
            onClick={() => { setTargetType('teacher'); setWinner(null); }}
            className={`px-4 py-2 text-sm font-bold rounded-xl transition ${targetType === 'teacher' ? 'bg-brand-700 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            Teacher Raffle
          </button>
        </div>
      </div>

      {/* Control Filters and Visual Drawer */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-6">
        {/* Filters Sidebar */}
        <div className="bg-white p-5 rounded-3xl border border-gray-155 shadow-sm space-y-4">
          <h3 className="font-display font-black text-navy-950 text-sm border-b pb-2 uppercase tracking-wider">Configure Pool</h3>
          
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Time Range</label>
            <select value={timeRange} onChange={e => { setTimeRange(e.target.value); setWinner(null); }} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none bg-white">
              <option value="week">This Week (Last 7 Days)</option>
              <option value="month">This Month (Last 30 Days)</option>
              <option value="all">All Time</option>
            </select>
          </div>

          {targetType === 'student' && (
            <>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Grade Level</label>
                <select value={selectedGrade} onChange={e => { setSelectedGrade(e.target.value); setWinner(null); }} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none bg-white">
                  <option value="">All Grades</option>
                  {grades.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">Homeroom</label>
                <select value={selectedHomeroom} onChange={e => { setSelectedHomeroom(e.target.value); setWinner(null); }} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none bg-white">
                  <option value="">All Homerooms</option>
                  {homerooms.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </>
          )}

          <div className="bg-slate-50 border border-slate-100 p-3 rounded-2xl text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-gray-400 font-bold">Total Candidates:</span>
              <span className="font-black text-navy-950">{candidates.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400 font-bold">Total Entries:</span>
              <span className="font-black text-navy-950">{totalTickets}</span>
            </div>
            <p className="text-[10px] text-gray-400 italic mt-2">Chance of winning is proportional to tickets earned during the period.</p>
          </div>
        </div>

        {/* Visual Drawing Stage */}
        <div className="bg-gradient-to-br from-navy-900 to-navy-950 p-6 rounded-3xl border border-navy-700 shadow-xl flex flex-col items-center justify-center min-h-[400px] relative overflow-hidden text-center text-white">
          {/* Decorative Stars */}
          <div className="absolute inset-0 opacity-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-yellow-300 via-transparent to-transparent pointer-events-none"></div>

          {!isDrawing && !winner ? (
            <div className="space-y-6 z-10">
              <div className="w-24 h-24 bg-navy-800 border-2 border-yellow-500 rounded-full flex items-center justify-center mx-auto text-yellow-500 shadow-lg shadow-yellow-500/20">
                <Ticket className="w-12 h-12" />
              </div>
              <div>
                <h2 className="text-2xl font-black font-display text-white">Ready for Draw</h2>
                <p className="text-sm text-navy-200 mt-2 max-w-sm mx-auto">Click below to start the weighted draw. Candidates with more tickets have a higher chance of winning!</p>
              </div>
              <button
                onClick={handleDraw}
                disabled={candidates.length === 0}
                className="bg-yellow-500 hover:bg-yellow-600 disabled:opacity-40 disabled:hover:bg-yellow-500 text-navy-950 font-black px-8 py-3.5 rounded-2xl shadow-lg shadow-yellow-500/10 transition text-base"
              >
                Start Raffle Draw
              </button>
            </div>
          ) : isDrawing ? (
            <div className="space-y-6 z-10 w-full max-w-md">
              <div className="text-yellow-400 uppercase tracking-widest text-xs font-black animate-pulse">Drawing Winner...</div>
              <div className="h-28 flex items-center justify-center border-y-2 border-navy-800 bg-navy-950/60 p-4 rounded-xl shadow-inner">
                <div className="text-3xl font-black font-display tracking-tight text-white animate-fade-in truncate w-full">
                  {tickerName}
                </div>
              </div>
              <p className="text-xs text-navy-300 italic">Rolling the weighted ticket drum...</p>
            </div>
          ) : (
            <div className="space-y-6 z-10 animate-fade-in max-w-md">
              <div className="text-yellow-400 uppercase tracking-widest text-xs font-black">Winner Drawn! 🎉</div>
              <div className="bg-yellow-500 text-navy-955 p-6 rounded-3xl shadow-xl shadow-yellow-500/20 border-4 border-white inline-block w-full">
                <Crown className="w-12 h-12 mx-auto mb-2 text-navy-950 fill-current" />
                <h2 className="text-3xl font-black font-display truncate leading-tight">{winner.name}</h2>
                {winner.homeroom && (
                  <p className="text-xs font-bold text-navy-900 mt-1 uppercase tracking-wider">
                    {winner.homeroom} · {winner.grade}
                  </p>
                )}
                <div className="bg-navy-900 text-white rounded-2xl px-4 py-2 mt-4 inline-block text-xs font-bold">
                  {winner.count} Tickets Earned This Period ({Math.round((winner.count / totalTickets) * 100)}% Chance)
                </div>
              </div>
              <div className="flex gap-3 justify-center mt-6">
                <button
                  onClick={handleDraw}
                  className="bg-navy-800 hover:bg-navy-750 text-white font-bold px-6 py-2.5 rounded-xl border border-navy-700 transition text-sm"
                >
                  Draw Another
                </button>
                <button
                  onClick={() => { setWinner(null); setShowConfetti(false); }}
                  className="bg-white hover:bg-gray-50 text-navy-950 font-bold px-6 py-2.5 rounded-xl transition text-sm"
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Candidate List Table */}
      <div className="bg-white rounded-3xl border border-gray-155 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b bg-gray-50 flex items-center justify-between">
          <h3 className="font-display font-black text-navy-955 text-sm">Raffle Candidates ({candidates.length})</h3>
          <span className="text-xs text-gray-505">Weighted entry list</span>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="p-8 text-center text-gray-500 italic">No candidates matching the current filters.</div>
          ) : (
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50 text-[10px] font-bold uppercase text-gray-450 border-b">
                <tr>
                  <th className="px-6 py-3">Candidate</th>
                  {targetType === 'student' && <th className="px-6 py-3">Homeroom / Grade</th>}
                  <th className="px-6 py-3 text-center">Entries</th>
                  <th className="px-6 py-3 text-right">Win Probability</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {candidates.sort((a, b) => b.count - a.count).map(c => (
                  <tr key={c.name} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-3 font-bold text-navy-955">{c.name}</td>
                    {targetType === 'student' && (
                      <td className="px-6 py-3 text-xs text-gray-500">{c.homeroom} · {c.grade}</td>
                    )}
                    <td className="px-6 py-3 text-center font-bold text-brand-700">{c.count}</td>
                    <td className="px-6 py-3 text-right font-medium text-gray-500">
                      {Math.round((c.count / totalTickets) * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Confetti Particles Visual Element ---
const ConfettiEffect = () => {
  const colors = ['bg-red-500', 'bg-blue-500', 'bg-yellow-500', 'bg-green-500', 'bg-pink-500', 'bg-purple-500'];
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-50">
      {[...Array(80)].map((_, i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 3;
        const duration = 2 + Math.random() * 2;
        const size = 5 + Math.random() * 8;
        const color = colors[Math.floor(Math.random() * colors.length)];
        return (
          <div
            key={i}
            className={`absolute rounded-xs animate-confetti ${color}`}
            style={{
              left: `${left}%`,
              top: `-20px`,
              width: `${size}px`,
              height: `${size}px`,
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`
            }}
          />
        );
      })}
    </div>
  );
};

// --- Edit Student Modal ---
function EditStudentModal({ student, onClose, showToast }) {
  const [studentId, setStudentId] = useState(student.id);
  const [name, setName] = useState(student.name);
  const [homeroom, setHomeroom] = useState(student.homeroom);
  const [grade, setGrade] = useState(student.grade);
  const [pinCode, setPinCode] = useState(student.pinCode);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!studentId.trim() || !name.trim() || !homeroom.trim() || !grade.trim() || !pinCode.trim()) {
      showToast("All fields are required.");
      return;
    }
    setLoading(true);
    try {
      await api.fetch(`/api/students/${student.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          id: studentId.trim(),
          name: name.trim(),
          homeroom: homeroom.trim(),
          grade: grade.trim(),
          pinCode: pinCode.trim()
        })
      });
      showToast(`Student profile updated successfully!`);
      onClose();
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to update student.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-navy-950/45 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-3xl p-6 max-w-sm w-full border border-gray-100 shadow-xl space-y-4">
        <div className="flex justify-between items-center border-b pb-3">
          <h3 className="font-display font-black text-navy-955 text-base">Edit Student Credentials</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-705"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Student Full Name</label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Login Student ID (Editable)</label>
            <input type="text" required value={studentId} onChange={e => setStudentId(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Login PIN (4 digits)</label>
            <input type="text" required maxLength={6} value={pinCode} onChange={e => setPinCode(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Homeroom</label>
              <input type="text" required value={homeroom} onChange={e => setHomeroom(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 mb-1">Grade</label>
              <input type="text" required value={grade} onChange={e => setGrade(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border rounded-xl text-sm font-bold text-gray-600 bg-white">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 border rounded-xl text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">{loading ? 'Saving...' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Change Password Modal ---
function ChangePasswordModal({ onClose, showToast }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!currentPassword.trim() || !newPassword.trim()) {
      showToast("All fields are required.");
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast("New passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await api.fetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      showToast(`Password updated successfully!`);
      onClose();
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to reset password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-navy-950/45 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-3xl p-6 max-w-sm w-full border border-gray-100 shadow-xl space-y-4">
        <div className="flex justify-between items-center border-b pb-3">
          <h3 className="font-display font-black text-navy-955 text-base">Reset Account Password</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-705"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Current Password</label>
            <input type="password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">New Password</label>
            <input type="password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Confirm New Password</label>
            <input type="password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-xl text-sm focus:ring-green-500 focus:border-green-500 outline-none" />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border rounded-xl text-sm font-bold text-gray-600 bg-white">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 border rounded-xl text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">{loading ? 'Updating...' : 'Update Password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Components ---
function Navbar({ profile, tickets, onSignOut, onRoleSwitch, onHelp, activeView, setActiveView, onChangePassword }) {
  const handleExport = () => {
    let data = profile.role === 'admin' ? tickets : tickets.filter(t => t.teacherEmail === profile.email);
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
          <span className="font-bold text-xl tracking-tight cursor-pointer" onClick={() => setActiveView('dashboard')}>Green Tickets</span>
        </div>
        <div className="flex items-center gap-2 md:gap-4">
          <span className="hidden lg:block text-sm font-medium bg-green-800 px-3 py-1 rounded-full">
            {profile.name} ({profile.role})
          </span>
          <button onClick={() => setActiveView('dashboard')} className={`flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium ${activeView === 'dashboard' ? 'bg-green-850' : ''}`}>
            Dashboard
          </button>
          <button onClick={() => setActiveView('raffle')} className={`flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium ${activeView === 'raffle' ? 'bg-green-850' : ''}`}>
            Weekly Raffle
          </button>
          <button onClick={onHelp} className="flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium">
            <HelpCircle className="w-4 h-4" /> Help
          </button>
          <button onClick={onRoleSwitch} className="flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium">
            <Settings className="w-4 h-4" /> Role
          </button>
          <button onClick={onChangePassword} className="flex items-center gap-2 hover:bg-green-600 px-3 py-1.5 rounded transition text-sm font-medium">
            <Lock className="w-4 h-4" /> Password
          </button>
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

function Login({ onLoginSuccess, showToast }) {
  const [activeTab, setActiveTab] = useState('student'); // 'student' or 'teacher'
  const [isRegistering, setIsRegistering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form Fields
  const [studentId, setStudentId] = useState('');
  const [pinCode, setPinCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('homeroom');
  const [adminPassword, setAdminPassword] = useState('');

  const handleStudentSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.fetch('/api/auth/student', {
        method: 'POST',
        body: JSON.stringify({ studentId, pinCode })
      });
      showToast(`Welcome back, ${data.profile.name}!`);
      onLoginSuccess(data.profile, data.token);
    } catch (err) {
      setError(err.message || 'Invalid Student ID or PIN');
    } finally {
      setLoading(false);
    }
  };

  const handleTeacherSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegistering) {
        await api.fetch('/api/auth/teacher/register', {
          method: 'POST',
          body: JSON.stringify({ email, password, name, role, adminPassword: role === 'admin' ? adminPassword : undefined })
        });
        showToast("Registration successful! Logging in...");
      }
      
      const data = await api.fetch('/api/auth/teacher', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      showToast(`Logged in as ${data.profile.name}`);
      onLoginSuccess(data.profile, data.token);
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-3xl shadow-xl border border-brand-100">
        <div className="text-center">
          <div className="flex justify-center">
            <div className="bg-brand-100 p-3 rounded-2xl">
              <Ticket className="w-10 h-10 text-brand-600 animate-pulse" aria-hidden="true" />
            </div>
          </div>
          <h2 className="mt-4 text-3xl font-extrabold text-navy-900 font-display">Roadrunner Tracker</h2>
          <p className="mt-2 text-sm text-gray-500">Earn Tickets. Build Community.</p>
        </div>

        {/* Tab Toggle */}
        <div role="tablist" className="flex bg-gray-100 p-1 rounded-xl">
          <button
            role="tab"
            aria-selected={activeTab === 'student'}
            onClick={() => { setActiveTab('student'); setError(''); }}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${activeTab === 'student' ? 'bg-brand-600 text-white shadow-sm' : 'text-gray-500 hover:text-navy-900'}`}
          >
            Student Portal
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'teacher'}
            onClick={() => { setActiveTab('teacher'); setError(''); }}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${activeTab === 'teacher' ? 'bg-brand-600 text-white shadow-sm' : 'text-gray-500 hover:text-navy-900'}`}
          >
            Teacher Access
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4 rounded-md" role="alert">
            <div className="flex">
              <div className="flex-shrink-0">
                <AlertTriangle className="h-5 w-5 text-red-400" aria-hidden="true" />
              </div>
              <div className="ml-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'student' ? (
          <form className="mt-6 space-y-4" onSubmit={handleStudentSubmit}>
            <div>
              <label htmlFor="student-id" className="block text-sm font-bold text-gray-700">Student Number</label>
              <input
                id="student-id"
                type="text"
                inputMode="numeric"
                required
                value={studentId}
                onChange={e => setStudentId(e.target.value)}
                className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-center text-lg font-bold tracking-widest"
                placeholder="e.g. 1001"
              />
            </div>
            <div>
              <label htmlFor="student-pin" className="block text-sm font-bold text-gray-700">4-Digit PIN</label>
              <input
                id="student-pin"
                type="password"
                maxLength={4}
                required
                value={pinCode}
                onChange={e => setPinCode(e.target.value)}
                className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition tracking-widest text-center text-lg font-bold"
                placeholder="••••"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-3 px-4 border border-transparent text-sm font-bold rounded-xl text-white bg-brand-600 hover:bg-brand-700 focus:outline-none transition disabled:opacity-50 mt-6"
            >
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleTeacherSubmit}>
            {isRegistering && (
              <>
                <div>
                  <label htmlFor="teacher-name" className="block text-sm font-bold text-gray-700">Last Name</label>
                  <input
                    id="teacher-name"
                    type="text"
                    required
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                    placeholder="e.g. Smith"
                  />
                </div>
                <div>
                  <label htmlFor="teacher-role" className="block text-sm font-bold text-gray-700">Role</label>
                  <select
                    id="teacher-role"
                    value={role}
                    onChange={e => setRole(e.target.value)}
                    className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition bg-white"
                  >
                    <option value="homeroom">Homeroom Teacher</option>
                    <option value="specialist">Specialist</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
                {role === 'admin' && (
                  <div>
                    <label htmlFor="admin-password" className="block text-sm font-bold text-gray-700">Admin Password</label>
                    <input
                      id="admin-password"
                      type="password"
                      required
                      value={adminPassword}
                      onChange={e => setAdminPassword(e.target.value)}
                      className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                      placeholder="Enter admin password"
                    />
                  </div>
                )}
              </>
            )}
            <div>
              <label htmlFor="teacher-email" className="block text-sm font-bold text-gray-700">Email Address</label>
              <input
                id="teacher-email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                placeholder="teacher@school.edu"
              />
            </div>
            <div>
              <label htmlFor="teacher-password" className="block text-sm font-bold text-gray-700">Password</label>
              <input
                id="teacher-password"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="mt-1 w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-3 px-4 border border-transparent text-sm font-bold rounded-xl text-white bg-brand-600 hover:bg-brand-700 focus:outline-none transition disabled:opacity-50 mt-6"
            >
              {loading ? 'Processing...' : isRegistering ? 'Register & Log In' : 'Log In'}
            </button>
            <div className="text-center mt-4">
              <button
                type="button"
                onClick={() => setIsRegistering(!isRegistering)}
                className="text-xs text-brand-600 hover:underline font-semibold"
              >
                {isRegistering ? 'Already have an account? Log in instead' : 'Need an account? Register here'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function MathSprintGame() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(30);
  const [num1, setNum1] = useState(0);
  const [num2, setNum2] = useState(0);
  const [op, setOp] = useState('+');
  const [answer, setAnswer] = useState('');
  const [highScore, setHighScore] = useState(() => Number(localStorage.getItem('math_sprint_highscore') || 0));
  const [message, setMessage] = useState('');
  const [correctAnswer, setCorrectAnswer] = useState(0);

  const generateQuestion = () => {
    const ops = ['+', '-', '*'];
    const selectedOp = ops[Math.floor(Math.random() * ops.length)];
    let n1, n2;
    if (selectedOp === '*') {
      n1 = Math.floor(Math.random() * 8) + 2;
      n2 = Math.floor(Math.random() * 8) + 2;
    } else {
      n1 = Math.floor(Math.random() * 40) + 10;
      n2 = Math.floor(Math.random() * 30) + 5;
      if (n1 < n2) {
        const temp = n1;
        n1 = n2;
        n2 = temp;
      }
    }
    setNum1(n1);
    setNum2(n2);
    setOp(selectedOp);
    let ans;
    if (selectedOp === '+') ans = n1 + n2;
    else if (selectedOp === '-') ans = n1 - n2;
    else ans = n1 * n2;
    setCorrectAnswer(ans);
    setAnswer('');
    setMessage('');
  };

  const startGame = () => {
    setIsPlaying(true);
    setScore(0);
    setTimeLeft(30);
    generateQuestion();
  };

  useEffect(() => {
    if (!isPlaying) return;
    if (timeLeft <= 0) {
      setIsPlaying(false);
      if (score > highScore) {
        setHighScore(score);
        localStorage.setItem('math_sprint_highscore', score);
        setMessage('New Personal Best! 🎉');
      } else {
        setMessage('Game Over! Great job! 🌟');
      }
      return;
    }
    const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, isPlaying, score, highScore]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const parsedAns = Number(answer.trim());
    if (parsedAns === correctAnswer) {
      setScore(s => s + 10);
      setMessage('Correct! +10 pts 🌟');
      setTimeout(generateQuestion, 500);
    } else {
      setMessage('Try again! ❌');
    }
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-between space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-bold text-navy-950 text-lg flex items-center gap-2">
          <Gamepad2 className="w-5 h-5 text-purple-500" aria-hidden="true" />
          <span>Brain Sprint Math Game</span>
        </h2>
        <span className="text-xs font-bold text-purple-600 bg-purple-50 px-2.5 py-1 rounded-full">High Score: {highScore} pts</span>
      </div>
      
      {!isPlaying ? (
        <div className="text-center py-6 space-y-4 flex-1 flex flex-col justify-center">
          <p className="text-sm text-gray-500">Train your brain! Answer as many math equations as you can in 30 seconds!</p>
          <button 
            onClick={startGame}
            className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2.5 px-6 rounded-xl transition text-sm shadow-sm w-fit mx-auto cursor-pointer"
          >
            Start Game 🚀
          </button>
          {message && <div className="text-sm font-bold text-brand-600 animate-bounce">{message}</div>}
        </div>
      ) : (
        <div className="space-y-4 flex-1 flex flex-col justify-between">
          <div className="flex justify-between items-center text-sm font-bold text-gray-600">
            <div>Score: <span className="text-purple-600">{score}</span></div>
            <div className={`${timeLeft <= 5 ? 'text-red-500 animate-pulse' : 'text-gray-500'}`}>Time Left: {timeLeft}s</div>
          </div>
          <div className="bg-purple-50/50 p-6 rounded-2xl text-center border border-purple-100">
            <div className="text-3xl font-black text-purple-900 font-display select-none">
              {num1} {op === '*' ? '×' : op} {num2} = ?
            </div>
          </div>
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input 
              type="number"
              required
              autoFocus
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder="Your answer"
              className="flex-1 p-3 border border-gray-300 rounded-xl text-center font-bold text-lg focus:ring-purple-500 focus:border-purple-500 outline-none"
            />
            <button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white px-5 rounded-xl font-bold transition text-sm shadow-sm cursor-pointer">Submit</button>
          </form>
          {message && (
            <div className={`text-center text-xs font-bold ${message.includes('Correct') ? 'text-green-600' : 'text-red-500'}`}>
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StudentDashboard({ studentData, onSignOut }) {
  const { profile, tickets, spending, classGoal, gradeGoal, wallet, goldenCount, classTicketsEarned, gradeGoldenEarned } = studentData;
  const [avatar, setAvatar] = useState(() => {
    return localStorage.getItem(`avatar_${profile.name}`) || '🐼';
  });
  const [showAvatarModal, setShowAvatarModal] = useState(false);

  const avatars = [
    { emoji: '🐼', name: 'Friendly Panda' },
    { emoji: '🦁', name: 'Brave Lion' },
    { emoji: '🦊', name: 'Clever Fox' },
    { emoji: '🦖', name: 'Super Dino' },
    { emoji: '🦉', name: 'Wise Owl' },
    { emoji: '🦄', name: 'Cosmic Unicorn' },
    { emoji: '🐨', name: 'Happy Koala' },
    { emoji: '🚀', name: 'Space Explorer' },
    { emoji: '🐝', name: 'Busy Bee' },
    { emoji: '🐸', name: 'Leaping Frog' },
  ];

  const handleSelectAvatar = (emoji) => {
    setAvatar(emoji);
    localStorage.setItem(`avatar_${profile.name}`, emoji);
    setShowAvatarModal(false);
  };

  const reasonCounts = { Respectful: 0, Responsible: 0, Determined: 0 };
  tickets.forEach(t => {
    if (reasonCounts[t.reason] !== undefined) reasonCounts[t.reason]++;
  });

  const recentActivity = [
    ...tickets.map(t => ({ ...t, type: 'earned', key: `t-${t.id}` })),
    ...spending.map(s => ({ ...s, type: 'spent', key: `s-${s.id}` }))
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const classProgress = classGoal && classGoal.goalTickets ? Math.min(100, Math.round((classTicketsEarned / classGoal.goalTickets) * 100)) : 0;
  const gradeProgress = gradeGoal && gradeGoal.goalGolden ? Math.min(100, Math.round((gradeGoldenEarned / gradeGoal.goalGolden) * 100)) : 0;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans text-gray-800">
      <nav className="bg-brand-700 text-white shadow-md" aria-label="Main Navigation">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Ticket className="w-8 h-8 text-brand-200" aria-hidden="true" />
              <span className="font-display font-bold text-xl tracking-tight">Roadrunner Student Portal</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm font-semibold text-brand-100 hidden sm:inline">Hello, {profile.name}</span>
              <button
                onClick={onSignOut}
                aria-label="Sign Out"
                className="flex items-center gap-1 bg-brand-800 hover:bg-brand-900 px-3 py-1.5 rounded-lg text-xs font-bold transition"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto w-full space-y-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            {/* Mascot Avatar Display */}
            <div className="w-16 h-16 rounded-full bg-brand-100 flex items-center justify-center text-4xl shadow-inner border border-brand-200 flex-shrink-0 relative group">
              <span className="select-none">{avatar}</span>
              <button 
                onClick={() => setShowAvatarModal(true)} 
                title="Change Avatar"
                className="absolute inset-0 bg-black/40 text-white text-[10px] font-black rounded-full opacity-0 group-hover:opacity-100 transition flex items-center justify-center cursor-pointer border-none outline-none"
              >
                EDIT
              </button>
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-navy-950 font-display">Welcome Back, {profile.name}!</h1>
              <p className="text-gray-500 text-sm mt-1">Homeroom: <span className="font-bold text-navy-800">{profile.homeroom || 'N/A'}</span> • Grade: <span className="font-bold text-navy-800">{profile.grade || 'N/A'}</span></p>
            </div>
          </div>
          <div className="bg-brand-50 border border-brand-100 px-6 py-4 rounded-xl flex items-center gap-4">
            <div className="bg-brand-600 p-2.5 rounded-xl text-white">
              <Award className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <div className="text-xs text-brand-700 font-bold uppercase tracking-wider">Spendable Balance</div>
              <div className="text-3xl font-black text-brand-900 leading-none mt-1">{wallet.balance} <span className="text-sm font-bold text-brand-700">Tickets</span></div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-navy-950 text-lg flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-500" aria-hidden="true" />
                <span>Class Reward Goal</span>
              </h2>
              {classGoal && <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">{classProgress}% Complete</span>}
            </div>
            {classGoal ? (
              <div className="space-y-3">
                <div className="text-navy-900 font-semibold">{classGoal.rewardText}</div>
                <div className="flex justify-between text-xs text-gray-500 font-medium">
                  <span>Class Tickets: {classTicketsEarned}</span>
                  <span>Goal: {classGoal.goalTickets}</span>
                </div>
                <div 
                  role="progressbar" 
                  aria-valuenow={classProgress} 
                  aria-valuemin="0" 
                  aria-valuemax="100" 
                  aria-label="Class reward goal progress"
                  className="w-full bg-gray-100 rounded-full h-3.5 overflow-hidden"
                >
                  <div className="bg-blue-500 h-full rounded-full transition-all duration-500" style={{ width: `${classProgress}%` }} />
                </div>
              </div>
            ) : (
              <div className="text-gray-400 text-sm text-center py-6">No class goal has been set by your homeroom teacher yet.</div>
            )}
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-navy-950 text-lg flex items-center gap-2">
                <Crown className="w-5 h-5 text-amber-500" aria-hidden="true" />
                <span>Grade Golden Ticket Goal</span>
              </h2>
              {gradeGoal && <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full">{gradeProgress}% Complete</span>}
            </div>
            {gradeGoal ? (
              <div className="space-y-3">
                <div className="text-navy-900 font-semibold">{gradeGoal.rewardText}</div>
                <div className="flex justify-between text-xs text-gray-500 font-medium">
                  <span>Grade Golden Tickets: {gradeGoldenEarned}</span>
                  <span>Goal: {gradeGoal.goalGolden}</span>
                </div>
                <div 
                  role="progressbar" 
                  aria-valuenow={gradeProgress} 
                  aria-valuemin="0" 
                  aria-valuemax="100" 
                  aria-label="Grade golden ticket goal progress"
                  className="w-full bg-gray-100 rounded-full h-3.5 overflow-hidden"
                >
                  <div className="bg-amber-500 h-full rounded-full transition-all duration-500" style={{ width: `${gradeProgress}%` }} />
                </div>
              </div>
            ) : (
              <div className="text-gray-400 text-sm text-center py-6">No grade-level golden ticket goal has been set by the administrator yet.</div>
            )}
          </div>

          {/* Educational game for engagement */}
          <MathSprintGame />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-blue-50 border border-blue-100 p-5 rounded-2xl text-center space-y-1">
            <div className="text-2xl font-black text-blue-900">{reasonCounts.Respectful}</div>
            <div className="text-xs font-bold text-blue-700 uppercase tracking-wider">Respectful Tickets</div>
          </div>
          <div className="bg-amber-50 border border-amber-100 p-5 rounded-2xl text-center space-y-1">
            <div className="text-2xl font-black text-amber-900">{reasonCounts.Responsible}</div>
            <div className="text-xs font-bold text-amber-700 uppercase tracking-wider">Responsible Tickets</div>
          </div>
          <div className="bg-purple-50 border border-purple-100 p-5 rounded-2xl text-center space-y-1">
            <div className="text-2xl font-black text-purple-900">{reasonCounts.Determined}</div>
            <div className="text-xs font-bold text-purple-700 uppercase tracking-wider">Determined Tickets</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
            <h3 className="font-bold text-navy-950 font-display text-base">My Recent Activity</h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
            {recentActivity.length > 0 ? (
              recentActivity.map(act => (
                <div key={act.key} className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition">
                  <div className="flex items-center gap-3">
                    <span className={`w-2.5 h-2.5 rounded-full ${act.type === 'earned' ? (act.reason === 'Respectful' ? 'bg-blue-500' : act.reason === 'Responsible' ? 'bg-amber-500' : 'bg-purple-500') : 'bg-red-500'}`} aria-hidden="true" />
                    <div>
                      <div className="font-semibold text-gray-900 text-sm">
                        {act.type === 'earned' ? `Earned ticket for being ${act.reason}` : `Redeemed points for ${act.item || 'Item'}`}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {act.type === 'earned' ? `Given by ${act.teacherName}` : `Approved by ${act.teacherName}`} • {new Date(act.timestamp).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <div className={`font-black text-sm ${act.type === 'earned' ? 'text-brand-600' : 'text-red-600'}`}>
                    {act.type === 'earned' ? '+1' : `-${act.amount}`}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-gray-400 text-center py-12 text-sm">You haven&apos;t earned or spent any tickets yet. Keep up the good work!</div>
            )}
          </div>
        </div>
      </main>

      {/* Avatar Modal */}
      {showAvatarModal && (
        <div className="fixed inset-0 bg-navy-950/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full border border-gray-100 shadow-xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-display font-black text-navy-950 text-base">Choose Your Mascot Avatar!</h3>
              <button onClick={() => setShowAvatarModal(false)} className="text-gray-400 hover:text-gray-700 cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-5 gap-3">
              {avatars.map(av => (
                <button
                  key={av.emoji}
                  onClick={() => handleSelectAvatar(av.emoji)}
                  title={av.name}
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl border hover:bg-brand-50 hover:border-brand-500 transition duration-150 cursor-pointer ${avatar === av.emoji ? 'border-brand-600 bg-brand-50' : 'border-gray-200 bg-white'}`}
                >
                  {av.emoji}
                </button>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <button onClick={() => setShowAvatarModal(false)} className="px-4 py-2 border rounded-xl text-sm font-bold text-gray-600 bg-white cursor-pointer">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Homeroom Dashboard ---
function HomeroomDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets, myUids, classGoals, setClassGoals, spending, balances, absentStudents, onToggleAbsent, onEditStudent, onPrintLoginCards }) {
  const [modalData, setModalData] = useState(null);
  const [isDisplayMode, setIsDisplayMode] = useState(false);
  const [awardDate, setAwardDate] = useState('today'); // 'today', 'yesterday', 'other'
  const [customDate, setCustomDate] = useState(''); // specific date picker value
  const [showGoalSettings, setShowGoalSettings] = useState(false);
  const [goalTarget, setGoalTarget] = useState(50);
  const [rewardText, setRewardText] = useState('Pajama Party');

  // Add individual student state
  const [showAddStudent, setShowAddStudent] = useState(false);
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentGrade, setNewStudentGrade] = useState(profile?.grade || '');

  // Spend points & display mode states
  const [spendData, setSpendData] = useState(null);
  const [hideBalances, setHideBalances] = useState(false);
  const [activeDisplayStudent, setActiveDisplayStudent] = useState(null);

  useEffect(() => {
    if (profile?.grade) {
      setNewStudentGrade(profile.grade);
    }
  }, [profile]);

  const handleCreateStudent = async (e) => {
    e.preventDefault();
    if (!newStudentName.trim() || !newStudentGrade.trim()) {
      showToast("Name and Grade are required.");
      return;
    }
    try {
      await api.fetch('/api/students', {
        method: 'POST',
        body: JSON.stringify({
          name: newStudentName.trim(),
          homeroom: profile.name,
          grade: newStudentGrade.trim()
        })
      });
      showToast(`Student ${newStudentName} added successfully to your class!`);
      setNewStudentName('');
      setShowAddStudent(false);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to add student.");
    }
  };

  const myStudents = useMemo(() => {
    const central = students.filter(s => s.homeroom === profile.name).map(s => s.name);
    const custom = profile.customStudents || [];
    return [...new Set([...central, ...custom])].sort();
  }, [students, profile]);

  const myStudentObjects = useMemo(() => {
    return students.filter(s => myStudents.includes(s.name));
  }, [students, myStudents]);

  const myTickets = useMemo(() => {
    return tickets.filter(t => myUids.has(t.teacherEmail));
  }, [tickets, myUids]);

  const ticketCounts = {};
  myStudents.forEach(s => ticketCounts[s] = 0);
  myTickets.forEach(t => { if (ticketCounts[t.recipient] !== undefined) ticketCounts[t.recipient]++; });

  // Calculate Class Goal
  const currentGoal = useMemo(() => {
    return classGoals.find(g => g.className === profile.name);
  }, [classGoals, profile.name]);

  useEffect(() => {
    if (currentGoal) {
      setGoalTarget(currentGoal.goalTickets || 50);
      setRewardText(currentGoal.rewardText || 'Pajama Party');
    }
  }, [currentGoal]);

  const classTicketsEarned = useMemo(() => {
    return myStudents.reduce((sum, studentName) => sum + (balances[studentName]?.earned || 0), 0);
  }, [myStudents, balances]);
  const goalProgress = Math.min(100, Math.round((classTicketsEarned / goalTarget) * 100));

  // Calculate Tickets Spent
  const classStudentsSet = useMemo(() => new Set(myStudents), [myStudents]);
  const totalSpent = useMemo(() => {
    return spending
      .filter(s => classStudentsSet.has(s.recipient))
      .reduce((sum, s) => sum + Number(s.amount || 0), 0);
  }, [spending, classStudentsSet]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);

  const resolveSelectedDate = () => {
    if (awardDate === 'today') return new Date().toISOString().split('T')[0];
    if (awardDate === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().split('T')[0];
    }
    return customDate || new Date().toISOString().split('T')[0];
  };

  const handleGiveTicketDirect = async (recipient, reason) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    setIsSubmitting(true);
    setSubmittingFor(recipient);
    try {
      await addDoc(collection(db, 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp(),
        customDate: resolveSelectedDate()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
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
      if (type === 'class') {
        const className = recipient.split(' (Whole Class)')[0];
        const classStudents = students.filter(s => s.homeroom === className);
        const presentStudents = classStudents.filter(s => !absentStudents.has(s.name));
        if (presentStudents.length === 0) {
          showToast("No present students to award tickets to.");
          setModalData(null);
          setIsSubmitting(false);
          return;
        }
        await Promise.all(presentStudents.map(student =>
          addDoc(collection(db, 'tickets'), {
            teacherId: user.uid, teacherName: profile.name,
            recipient: student.name, recipientType: 'student', reason, timestamp: serverTimestamp(),
            customDate: resolveSelectedDate()
          })
        ));
        showToast(`Regular ticket awarded to ${presentStudents.length} present students in ${className}!`);
      } else {
        await addDoc(collection(db, 'tickets'), {
          teacherId: user.uid, teacherName: profile.name,
          recipient, recipientType: type, reason, timestamp: serverTimestamp(),
          customDate: resolveSelectedDate()
        });
        showToast(`Ticket awarded to ${recipient}!`);
      }
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'tickets', ticketId));
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
      await addDoc(collection(db, 'goldenTickets'), {
        teacherId: user.uid, teacherName: profile.name,
        className: profile.name, timestamp: serverTimestamp()
      });
      showToast(`Golden Ticket awarded to ${profile.name}'s class!`);
    } catch (e) {
      console.error("Error awarding Golden Ticket:", e);
      showToast("Error awarding Golden Ticket.");
    }
  };

  const handleSaveClassGoal = async (e) => {
    e.preventDefault();
    try {
      await api.fetch('/api/class-goals', {
        method: 'POST',
        body: JSON.stringify({
          className: profile.name,
          goalTickets: Number(goalTarget),
          rewardText
        })
      });
      showToast("Class goal updated successfully!");
      setShowGoalSettings(false);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (err) {
      console.error("Error saving class goal:", err);
      showToast("Failed to save class goal.");
    }
  };

  const myClassGolden = goldenTickets.filter(g => g.className === profile.name).length;

  if (isDisplayMode) {
    return (
      <ClassDisplayMode
        className={profile.name}
        students={myStudents}
        balances={balances}
        classGoals={classGoals}
        isSubmitting={isSubmitting}
        handleGiveTicketDirect={handleGiveTicketDirect}
        onClose={() => setIsDisplayMode(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Metrics & Mode Controls Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
        {/* Award Date Group */}
        <div className="space-y-1.5 w-full md:w-auto">
          <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block flex items-center gap-1">
            <Star className="w-3.5 h-3.5 text-gray-400" />
            <span>Award Date</span>
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setAwardDate('today')}
              className={`px-4 py-2 rounded-xl text-sm font-bold border transition ${awardDate === 'today' ? 'bg-amber-500 border-amber-600 text-white shadow-sm' : 'bg-gray-50 hover:bg-gray-100 text-gray-700'}`}
            >
              Today
            </button>
            <button
              onClick={() => setAwardDate('yesterday')}
              className={`px-4 py-2 rounded-xl text-sm font-bold border transition ${awardDate === 'yesterday' ? 'bg-amber-500 border-amber-600 text-white shadow-sm' : 'bg-gray-50 hover:bg-gray-100 text-gray-700'}`}
            >
              Yesterday
            </button>
            <button
              onClick={() => setAwardDate('other')}
              className={`px-4 py-2 rounded-xl text-sm font-bold border transition flex items-center gap-1.5 ${awardDate === 'other' ? 'bg-amber-500 border-amber-600 text-white shadow-sm' : 'bg-gray-50 hover:bg-gray-100 text-gray-700'}`}
            >
              <Star className="w-4 h-4" />
              <span>Other</span>
            </button>
            {awardDate === 'other' && (
              <input
                type="date"
                value={customDate}
                onChange={e => setCustomDate(e.target.value)}
                className="p-1.5 border border-gray-300 rounded-lg text-sm focus:ring-amber-500 focus:border-amber-500 outline-none"
              />
            )}
          </div>
        </div>

        {/* Display Mode Button */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-end">
          <button
            type="button"
            onClick={() => {
              if (myStudentObjects.length === 0) {
                showToast("No students in your class to print cards for.");
                return;
              }
              onPrintLoginCards(myStudentObjects);
            }}
            className="flex items-center gap-2 bg-white hover:bg-gray-50 text-gray-700 font-bold py-2.5 px-4 rounded-xl shadow-sm border border-gray-200 transition text-sm cursor-pointer"
          >
            <Download className="w-4 h-4 text-gray-500" />
            <span>Print Login Cards</span>
          </button>

          <button
            onClick={() => setIsDisplayMode(true)}
            className="flex items-center gap-2 bg-brand-700 hover:bg-brand-800 text-white font-bold py-2.5 px-5 rounded-xl shadow-sm border border-brand-850 transition text-sm"
          >
            <Shield className="w-5 h-5 text-brand-200" />
            <span>Display Mode</span>
          </button>

          {/* Metrics Column */}
          <div className="bg-gray-50 border border-gray-100 px-4 py-2.5 rounded-xl text-center">
            <div className="text-xxs font-bold text-gray-400 uppercase tracking-wider">Tickets Given</div>
            <div className="text-xl font-black text-brand-600">{myTickets.length}</div>
          </div>

          <div className="bg-gray-50 border border-gray-100 px-4 py-2.5 rounded-xl text-center">
            <div className="text-xxs font-bold text-gray-400 uppercase tracking-wider">Tickets Spent</div>
            <div className="text-xl font-black text-red-600">{totalSpent}</div>
          </div>
        </div>
      </div>

      {/* Class Ticket Goal progress card */}
      <div className="bg-white border border-gray-150 p-6 rounded-2xl shadow-sm space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="font-display font-black text-navy-950 text-base flex items-center gap-2">
            <Star className="w-5 h-5 text-brand-500" />
            <span>MY CLASS TICKET GOAL</span>
          </h2>
          <button
            onClick={() => setShowGoalSettings(!showGoalSettings)}
            aria-label="Class Goal Settings"
            className="p-1.5 rounded-lg border border-gray-200 text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition"
          >
            <Shield className="w-4 h-4" />
          </button>
        </div>

        {showGoalSettings ? (
          <form onSubmit={handleSaveClassGoal} className="bg-gray-50 p-4 rounded-xl border border-gray-200 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="goal-target" className="block text-xs font-bold text-gray-600 mb-1">Goal Target (Tickets)</label>
                <input
                  id="goal-target"
                  type="number"
                  required
                  value={goalTarget}
                  onChange={e => setGoalTarget(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label htmlFor="reward-text" className="block text-xs font-bold text-gray-600 mb-1">Reward Description</label>
                <input
                  id="reward-text"
                  type="text"
                  required
                  value={rewardText}
                  onChange={e => setRewardText(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-lg text-sm"
                  placeholder="e.g. Pajama Party"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowGoalSettings(false)}
                className="px-3 py-1.5 border rounded-lg text-xs font-bold text-gray-600 bg-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 border rounded-lg text-xs font-bold text-white bg-brand-600 hover:bg-brand-700"
              >
                Save Goal
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2">
            <div className="flex justify-between text-sm font-bold text-navy-900">
              <span>Goal Target: <span className="text-brand-700">{goalTarget} tickets</span></span>
              <span>Reward: <span className="text-brand-700">{rewardText}</span></span>
            </div>
            <div 
              role="progressbar" 
              aria-valuenow={goalProgress} 
              aria-valuemin="0" 
              aria-valuemax="100" 
              aria-label="Class ticket goal progress"
              className="w-full bg-gray-100 rounded-full h-3.5 overflow-hidden flex items-center p-0.5"
            >
              <div className="bg-brand-500 h-full rounded-full transition-all duration-500" style={{ width: `${goalProgress}%` }} />
            </div>
            <div className="flex justify-between text-xxs font-bold text-gray-400">
              <span>0 TICKETS</span>
              <span className="text-center">{classTicketsEarned} / {goalTarget} TICKETS ({goalProgress}%)</span>
              <span>REWARD REACHED!</span>
            </div>
            <p className="text-xxs text-gray-400 italic text-center mt-1">Goal progress counts lifetime tickets earned — spending tickets never lowers it.</p>
          </div>
        )}
      </div>

      <div className="bg-gradient-to-r from-yellow-400 to-amber-500 p-5 rounded-2xl shadow-sm text-white flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Star className="w-8 h-8 text-yellow-100 animate-spin-slow" aria-hidden="true" />
          <div>
            <h3 className="text-lg font-bold">Golden Ticket</h3>
            <p className="text-yellow-100 text-sm">Award your class for awesome behavior! <span className="font-bold text-white">({myClassGolden} earned)</span></p>
          </div>
        </div>
        <button onClick={handleGoldenTicket} className="bg-white text-amber-700 px-6 py-3 rounded-xl font-bold shadow-sm hover:shadow-md transition w-full sm:w-auto">
          Award Golden Ticket
        </button>
      </div>

      <div className="flex justify-between items-center flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-navy-950 font-display">My Class Roster</h2>
          <p className="text-sm text-gray-500 mt-1">Award tickets, run your class class store, or toggle attendance below.</p>
        </div>
        <button
          onClick={() => setShowAddStudent(!showAddStudent)}
          className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white font-bold py-2 px-4 rounded-xl shadow-sm border border-brand-700 transition text-sm"
        >
          <Plus className="w-4 h-4" />
          <span>Add Student</span>
        </button>
      </div>

      {showAddStudent && (
        <form onSubmit={handleCreateStudent} className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm space-y-4 max-w-md">
          <h3 className="font-bold text-navy-950 text-sm">Add Individual Student to Class</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="new-student-name" className="block text-xs font-bold text-gray-600 mb-1">Student Full Name</label>
              <input
                id="new-student-name"
                type="text"
                required
                placeholder="e.g. Samuel Harbert"
                value={newStudentName}
                onChange={e => setNewStudentName(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-green-500 focus:border-green-500 outline-none"
              />
            </div>
            <div>
              <label htmlFor="new-student-grade" className="block text-xs font-bold text-gray-600 mb-1">Grade Level</label>
              <input
                id="new-student-grade"
                type="text"
                required
                placeholder="e.g. 3rd Grade"
                value={newStudentGrade}
                onChange={e => setNewStudentGrade(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-green-500 focus:border-green-500 outline-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowAddStudent(false)}
              className="px-3 py-1.5 border rounded-lg text-xs font-bold text-gray-600 bg-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 border rounded-lg text-xs font-bold text-white bg-brand-600 hover:bg-brand-700"
            >
              Add Student
            </button>
          </div>
        </form>
      )}

      {myStudents.length === 0 ? (
        <div className="bg-white p-8 rounded-xl border text-center text-gray-500">
          <Users className="w-12 h-12 mx-auto mb-3 text-gray-300" aria-hidden="true" />
          <p>No students assigned to &quot;{profile.name}&quot;.</p>
          <p className="text-sm mt-1">Admins can upload the central roster, or you can add custom students in settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {myStudents.map(student => (
            <StudentTicketCard key={student} student={student}
              onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor}
              balances={balances} onSpend={(s, spendable) => setSpendData({ student: s, spendable })}
              students={students} onEditStudent={onEditStudent} isAbsent={absentStudents.has(student)}
              onToggleAbsent={() => onToggleAbsent(student)} tickets={tickets} teacherEmail={profile.email} />
          ))}
        </div>
      )}

      <div className="mt-8 border-t pt-8 space-y-6">
        <StudentSearch students={students} onSelect={setModalData} />
        {myTickets.length > 0 && <TicketBreakdownBar tickets={myTickets} />}
        <RecentTicketsList ticketList={myTickets} onRemove={handleRemoveTicket} />
      </div>

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
      {spendData && <SpendPointsModal student={spendData.student} spendable={spendData.spendable} onClose={() => setSpendData(null)} showToast={showToast} />}
    </div>
  );
}

// --- Specialist Dashboard (Nested View) ---
function SpecialistDashboard({ profile, students, tickets, showToast, user, effectiveUid, goldenTickets, myUids, balances, classGoals = [], absentStudents, onToggleAbsent, onEditStudent, onPrintLoginCards }) {
  const [selectedClass, setSelectedClass] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [spendData, setSpendData] = useState(null);
  const [isDisplayMode, setIsDisplayMode] = useState(false);

  const classes = useMemo(() => {
    const homerooms = students.map(s => s.homeroom).filter(Boolean);
    return [...new Set(homerooms)].sort();
  }, [students]);

  const studentsInClass = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter(s => s.homeroom === selectedClass).map(s => s.name).sort();
  }, [selectedClass, students]);

  const classStudentObjects = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter(s => s.homeroom === selectedClass);
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
      await addDoc(collection(db, 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
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
      if (type === 'class') {
        const className = recipient.split(' (Whole Class)')[0];
        const classStudents = students.filter(s => s.homeroom === className);
        const presentStudents = classStudents.filter(s => !absentStudents.has(s.name));
        if (presentStudents.length === 0) {
          showToast("No present students to award tickets to.");
          setModalData(null);
          setIsSubmitting(false);
          return;
        }
        await Promise.all(presentStudents.map(student =>
          addDoc(collection(db, 'tickets'), {
            teacherId: user.uid, teacherName: profile.name,
            recipient: student.name, recipientType: 'student', reason, timestamp: serverTimestamp()
          })
        ));
        showToast(`Regular ticket awarded to ${presentStudents.length} present students in ${className}!`);
      } else {
        await addDoc(collection(db, 'tickets'), {
          teacherId: user.uid, teacherName: profile.name,
          recipient, recipientType: type, reason, timestamp: serverTimestamp()
        });
        showToast(`Ticket awarded to ${recipient}!`);
      }
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'tickets', ticketId));
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
      await addDoc(collection(db, 'goldenTickets'), {
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

  if (isDisplayMode) {
    return (
      <ClassDisplayMode
        className={selectedClass}
        students={studentsInClass}
        balances={balances}
        classGoals={classGoals}
        isSubmitting={isSubmitting}
        handleGiveTicketDirect={handleGiveTicketDirect}
        onClose={() => setIsDisplayMode(false)}
      />
    );
  }

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
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
            <div className="flex items-center gap-4">
              <button onClick={() => setSelectedClass(null)} className="p-2 bg-white border rounded-lg hover:bg-gray-50 text-gray-600"><ChevronLeft className="w-6 h-6" /></button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{selectedClass}&apos;s Class</h1>
                <p className="text-gray-500">Award the whole class, or pick a student.</p>
              </div>
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={() => {
                  if (classStudentObjects.length === 0) {
                    showToast("No students in this class to print cards for.");
                    return;
                  }
                  onPrintLoginCards(classStudentObjects);
                }}
                className="flex items-center gap-2 bg-white hover:bg-gray-50 text-gray-700 font-bold py-2.5 px-4 rounded-xl shadow-sm border border-gray-200 transition text-sm cursor-pointer"
              >
                <Download className="w-4 h-4 text-gray-500" />
                <span>Print Login Cards</span>
              </button>

              <button
                onClick={() => setIsDisplayMode(true)}
                className="bg-brand-600 hover:bg-brand-700 text-white font-bold py-2.5 px-5 rounded-xl transition flex items-center gap-2 shadow-xs text-sm sm:w-auto w-full justify-center"
              >
                <Tv className="w-4.5 h-4.5" />
                Class Display Mode
              </button>
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
                <StudentTicketCard key={student} student={student}
                  onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor}
                  balances={balances} onSpend={(s, spendable) => setSpendData({ student: s, spendable })}
                  students={students} onEditStudent={onEditStudent} isAbsent={absentStudents.has(student)}
                  onToggleAbsent={() => onToggleAbsent(student)} tickets={tickets} teacherEmail={profile.email} />
              ))}
            </div>
          )}
        </>
      )}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
      {spendData && <SpendPointsModal student={spendData.student} spendable={spendData.spendable} onClose={() => setSpendData(null)} showToast={showToast} />}
    </div>
  );
}

// --- Admin Dashboard (Includes CSV Upload + Give Tickets) ---
function AdminDashboard({ tickets, students, profiles, showToast, user, effectiveUid, profile, goldenTickets, myUids, balances, gradeGoals, classGoals = [], absentStudents, onToggleAbsent, onEditStudent, onPrintLoginCards }) {
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
  const [spendData, setSpendData] = useState(null);
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [isDisplayMode, setIsDisplayMode] = useState(false);
  const ITEMS_PER_PAGE = 25;

  // Grade Goals state
  const [gradeGoalGrade, setGradeGoalGrade] = useState('');
  const [gradeGoalGolden, setGradeGoalGolden] = useState(10);
  const [gradeGoalReward, setGradeGoalReward] = useState('Ice Cream Party');
  const [isSavingGradeGoal, setIsSavingGradeGoal] = useState(false);

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

  const classStudentObjects = useMemo(() => {
    if (!selectedClass) return [];
    return students.filter(s => s.homeroom === selectedClass);
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
      await addDoc(collection(db, 'tickets'), {
        teacherId: user.uid, teacherName: profile.name,
        recipient, recipientType: 'student', reason, timestamp: serverTimestamp()
      });
      showToast(`${reason} ticket awarded to ${recipient}!`);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
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
      if (type === 'class') {
        const className = recipient.split(' (Whole Class)')[0];
        const classStudents = students.filter(s => s.homeroom === className);
        const presentStudents = classStudents.filter(s => !absentStudents.has(s.name));
        if (presentStudents.length === 0) {
          showToast("No present students to award tickets to.");
          setModalData(null);
          setIsSubmitting(false);
          return;
        }
        await Promise.all(presentStudents.map(student =>
          addDoc(collection(db, 'tickets'), {
            teacherId: user.uid, teacherName: profile.name,
            recipient: student.name, recipientType: 'student', reason, timestamp: serverTimestamp()
          })
        ));
        showToast(`Regular ticket awarded to ${presentStudents.length} present students in ${className}!`);
      } else {
        await addDoc(collection(db, 'tickets'), {
          teacherId: user.uid, teacherName: profile.name,
          recipient, recipientType: type, reason, timestamp: serverTimestamp()
        });
        showToast(`Ticket awarded to ${recipient}!`);
      }
      setModalData(null);
    } catch (e) {
      console.error("Error saving ticket:", e);
      showToast(`Error saving ticket. Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveTicket = async (ticketId, recipient) => {
    try {
      await deleteDoc(doc(db, 'tickets', ticketId));
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
      await api.fetch('/api/roster/merge', {
        method: 'POST',
        body: JSON.stringify({ sourceName: mergeSource, targetName: mergeTarget })
      });
      const sourceTicketCount = tickets.filter(t => t.recipient === mergeSource).length;
      showToast(`Merged "${mergeSource}" into "${mergeTarget}". ${sourceTicketCount} ticket${sourceTicketCount !== 1 ? 's' : ''} reassigned.`);
      setMergeSource('');
      setMergeTarget('');
      setConfirmMerge(false);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (e) {
      console.error("Error merging students:", e);
      showToast(e.message || "Error merging students.");
    }
    setIsMerging(false);
  };

  const handleGoldenTicket = async (cls) => {
    if (!effectiveUid || !profile) {
      showToast("Your profile isn't fully loaded yet. Please wait a moment and try again.");
      return;
    }
    try {
      await addDoc(collection(db, 'goldenTickets'), {
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
      await deleteDoc(doc(db, 'goldenTickets', ticketId));
      showToast(`Removed Golden Ticket from ${className}'s class.`);
    } catch (e) {
      console.error("Error removing Golden Ticket:", e);
      showToast("Error removing Golden Ticket.");
    }
  };

  const mapHeader = (header) => {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['name', 'studentname', 'fullname', 'student', 'names'].includes(normalized)) return 'name';
    if (['homeroom', 'classroom', 'room', 'class', 'teacher', 'homeroomteacher'].includes(normalized)) return 'homeroom';
    if (['grade', 'gradelevel', 'year', 'level'].includes(normalized)) return 'grade';
    return null;
  };

  const parseCSVLine = (text, delimiter = ',') => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim().replace(/^"|"$/g, ''));
    return result;
  };

  const processCSVContent = async (text) => {
    setIsProcessing(true);
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (rawLines.length < 2) {
      showToast("CSV must contain a header row and at least one student row.");
      setIsProcessing(false);
      return;
    }

    // Auto-detect delimiter
    const firstLine = rawLines[0];
    const commaCount = (firstLine.match(/,/g) || []).length;
    const semiCount = (firstLine.match(/;/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    
    let delimiter = ',';
    if (semiCount > commaCount && semiCount > tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

    const headerRow = parseCSVLine(firstLine, delimiter);
    let nameIndex = -1;
    let homeroomIndex = -1;
    let gradeIndex = -1;

    headerRow.forEach((h, index) => {
      const mapped = mapHeader(h);
      if (mapped === 'name') nameIndex = index;
      else if (mapped === 'homeroom') homeroomIndex = index;
      else if (mapped === 'grade') gradeIndex = index;
    });

    if (nameIndex === -1 || homeroomIndex === -1) {
      showToast(`Missing headers. We need columns matching Name and Homeroom. Found columns: [${headerRow.join(', ')}].`);
      setIsProcessing(false);
      return;
    }

    const parsedStudents = [];
    let hasError = false;
    for (let i = 1; i < rawLines.length; i++) {
      const parts = parseCSVLine(rawLines[i], delimiter);
      if (parts.length <= Math.max(nameIndex, homeroomIndex)) continue;
      
      const name = parts[nameIndex];
      const homeroom = parts[homeroomIndex];
      const grade = gradeIndex !== -1 ? parts[gradeIndex] : 'N/A';
      
      if (!name || !homeroom) {
        showToast(`Line ${i + 1} has missing name or homeroom.`);
        hasError = true;
        break;
      }
      
      parsedStudents.push({ name, homeroom, grade: grade || 'N/A' });
    }

    if (hasError || parsedStudents.length === 0) {
      setIsProcessing(false);
      return;
    }

    try {
      const batch = writeBatch(db);
      parsedStudents.forEach(s => {
        const ref = doc(collection(db, 'students'));
        batch.set(ref, s);
      });
      await batch.commit();
      setCsvText('');
      showToast(`Successfully imported ${parsedStudents.length} students!`);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (e) {
      console.error(e);
      showToast("Error processing CSV.");
    }
    setIsProcessing(false);
  };

  const processCSV = () => {
    if (!csvText.trim()) return;
    processCSVContent(csvText);
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      processCSVContent(text);
    };
    reader.readAsText(file);
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
      await deleteDoc(doc(db, 'users', profileToDelete.email || profileToDelete.id));
      showToast(`Deleted profile for ${profileToDelete.name}.`);
      setConfirmDeleteProfile(null);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (e) {
      console.error("Error deleting profile:", e);
      showToast("Error deleting profile.");
    }
    setIsDeletingProfile(false);
  };

  const clearRoster = async () => {
    setIsClearing(true);
    try {
      await api.fetch('/api/roster/clear', { method: 'POST' });
      showToast(`Cleared ${students.length} students from the roster.`);
      setConfirmClear(false);
      if (window.triggerRefresh) window.triggerRefresh();
    } catch (e) {
      console.error(e);
      showToast("Error clearing roster.");
    }
    setIsClearing(false);
  };

  if (isDisplayMode && selectedClass) {
    return (
      <ClassDisplayMode
        className={selectedClass}
        students={studentsInClass}
        balances={balances}
        classGoals={classGoals}
        isSubmitting={isSubmitting}
        handleGiveTicketDirect={handleGiveTicketDirect}
        onClose={() => setIsDisplayMode(false)}
      />
    );
  }

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
          <button onClick={() => setActiveTab('gradeGoals')} className={`px-4 py-2 rounded-md font-medium text-sm transition ${activeTab === 'gradeGoals' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>Grade Goals</button>
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
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-2">
                <div className="flex items-center gap-4">
                  <button onClick={() => setSelectedClass(null)} className="p-2 bg-white border rounded-lg hover:bg-gray-50 text-gray-600"><ChevronLeft className="w-6 h-6" /></button>
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">{selectedClass}&apos;s Class</h2>
                    <p className="text-gray-500 text-sm">Award the whole class or pick a student.</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (classStudentObjects.length === 0) {
                        showToast("No students in this class to print cards for.");
                        return;
                      }
                      onPrintLoginCards(classStudentObjects);
                    }}
                    className="flex items-center gap-2 bg-white hover:bg-gray-50 text-gray-700 font-bold py-2.5 px-4 rounded-xl shadow-sm border border-gray-200 transition text-sm cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-gray-500" />
                    <span>Print Login Cards</span>
                  </button>

                  <button
                    onClick={() => setIsDisplayMode(true)}
                    className="bg-brand-600 hover:bg-brand-700 text-white font-bold py-2.5 px-5 rounded-xl transition flex items-center gap-2 shadow-xs text-sm sm:w-auto w-full justify-center"
                  >
                    <Tv className="w-4.5 h-4.5" />
                    Class Display Mode
                  </button>
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
                    <StudentTicketCard key={student} student={student}
                      onGiveTicket={handleGiveTicketDirect} isSubmitting={isSubmitting} submittingFor={submittingFor}
                      balances={balances} onSpend={(s, spendable) => setSpendData({ student: s, spendable })}
                      students={students} onEditStudent={onEditStudent} isAbsent={absentStudents.has(student)}
                      onToggleAbsent={() => onToggleAbsent(student)} tickets={tickets} teacherEmail={profile.email} />
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
      ) : activeTab === 'roster' ? (
        <div className="bg-white p-6 rounded-xl shadow-sm border max-w-3xl space-y-6">
          <div>
            <h2 className="text-xl font-bold mb-1">Central Roster Import</h2>
            <p className="text-gray-500 text-sm">
              Upload a student roster CSV file to sync the school database. Column headers will be automatically mapped to student details.
            </p>
          </div>

          {/* Drag & Drop File Upload Zone */}
          <div className="border-2 border-dashed border-gray-300 hover:border-green-500 rounded-2xl p-8 text-center transition bg-slate-50/50 cursor-pointer relative group">
            <input 
              type="file" 
              accept=".csv" 
              onChange={handleFileChange}
              disabled={isProcessing}
              className="absolute inset-0 opacity-0 cursor-pointer" 
            />
            <div className="space-y-2 pointer-events-none">
              <div className="w-12 h-12 bg-green-50 text-green-600 rounded-full flex items-center justify-center mx-auto group-hover:scale-105 transition-transform">
                <Download className="w-6 h-6" />
              </div>
              <div className="font-bold text-navy-950 text-sm">
                {isProcessing ? 'Processing file...' : 'Drag and drop your roster CSV file here, or click to browse'}
              </div>
              <div className="text-xs text-gray-400">Supported format: CSV (.csv) containing columns like Name, Homeroom, Grade</div>
            </div>
          </div>

          <div className="text-center">
            <button
              onClick={() => setShowManualPaste(!showManualPaste)}
              type="button"
              className="text-xs text-brand-600 hover:underline font-bold"
            >
              {showManualPaste ? 'Hide manual paste options' : 'Or paste CSV data manually'}
            </button>
          </div>

          {showManualPaste && (
            <div className="space-y-4 pt-4 border-t animate-fade-in">
              <p className="text-xs text-gray-500">
                Paste your CSV content below. Must include column headers matching <strong>name</strong>, <strong>homeroom</strong>, and <strong>grade</strong>.
              </p>
              <textarea
                rows="6"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="w-full border-gray-300 rounded-lg p-4 font-mono text-sm bg-gray-50 focus:border-green-500 focus:ring-green-500 border"
                placeholder={"name,homeroom,grade\nJane Doe, Mr. Smith, 3rd Grade\nJohn Smith, Ms. Davis, 4th Grade"}
              />
              <button
                onClick={processCSV}
                disabled={isProcessing || !csvText.trim()}
                className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-2.5 px-6 rounded-xl transition flex items-center gap-2 text-sm shadow-sm">
                {isProcessing ? 'Processing...' : 'Upload & Sync Paste Data'}
              </button>
            </div>
          )}

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
      ) : activeTab === 'gradeGoals' ? (
        <div className="max-w-2xl space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-amber-100 rounded-full text-amber-600"><Star className="w-6 h-6" /></div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Grade-Level Golden Ticket Goals</h2>
                <p className="text-sm text-gray-500">Set grade-wide golden ticket goals visible to students and homeroom teachers.</p>
              </div>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!gradeGoalGrade) { showToast('Please select a grade.'); return; }
              setIsSavingGradeGoal(true);
              try {
                await api.fetch('/api/grade-goals', {
                  method: 'POST',
                  body: JSON.stringify({
                    grade: gradeGoalGrade,
                    goalGolden: Number(gradeGoalGolden),
                    rewardText: gradeGoalReward
                  })
                });
                showToast(`Grade goal for ${gradeGoalGrade} saved!`);
                if (window.triggerRefresh) window.triggerRefresh();
              } catch (err) {
                console.error(err);
                showToast(err.message || 'Failed to save grade goal.');
              } finally {
                setIsSavingGradeGoal(false);
              }
            }} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Grade</label>
                <select value={gradeGoalGrade} onChange={e => setGradeGoalGrade(e.target.value)} className="w-full p-3 border border-gray-300 rounded-xl focus:ring-amber-500 focus:border-amber-500 outline-none bg-white">
                  <option value="">Select a grade...</option>
                  {[...new Set(students.map(s => s.grade).filter(Boolean))].sort().map(g => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Golden Ticket Goal</label>
                <input type="number" min="1" value={gradeGoalGolden} onChange={e => setGradeGoalGolden(e.target.value)} className="w-full p-3 border border-gray-300 rounded-xl focus:ring-amber-500 focus:border-amber-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Reward Description</label>
                <input type="text" value={gradeGoalReward} onChange={e => setGradeGoalReward(e.target.value)} placeholder="e.g. Ice Cream Party" className="w-full p-3 border border-gray-300 rounded-xl focus:ring-amber-500 focus:border-amber-500 outline-none" />
              </div>
              <button type="submit" disabled={isSavingGradeGoal || !gradeGoalGrade} className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-xl transition flex items-center gap-2">
                <Star className="w-4 h-4" /> {isSavingGradeGoal ? 'Saving...' : 'Save Grade Goal'}
              </button>
            </form>
          </div>

          {/* Existing Grade Goals */}
          {gradeGoals && gradeGoals.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b bg-amber-50">
                <h3 className="font-bold text-amber-800 flex items-center gap-2"><Star className="w-4 h-4" /> Current Grade Goals</h3>
              </div>
              <div className="divide-y">
                {gradeGoals.map(g => (
                  <div key={g.id || g.grade} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition">
                    <div>
                      <div className="font-bold text-gray-900">{g.grade}</div>
                      <div className="text-sm text-gray-500">{g.rewardText} — Goal: {g.goalGolden} golden tickets</div>
                    </div>
                    <button onClick={() => {
                      setGradeGoalGrade(g.grade);
                      setGradeGoalGolden(g.goalGolden || 10);
                      setGradeGoalReward(g.rewardText || '');
                    }} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold px-3 py-1.5 rounded-lg transition">Edit</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {modalData && <GiveTicketModal data={modalData} onClose={() => setModalData(null)} onSelect={handleGiveTicket} isSubmitting={isSubmitting} />}
      {spendData && <SpendPointsModal student={spendData.student} spendable={spendData.spendable} onClose={() => setSpendData(null)} showToast={showToast} />}
    </div>
  );
}

// --- Shared Modals ---
function HelpModal({ onClose }) {
  const [activeSection, setActiveSection] = useState('overview');
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'roles', label: 'Roles' },
    { id: 'tickets', label: 'Tickets' },
    { id: 'spending', label: 'Spending & Store' },
    { id: 'goals', label: 'Goals' },
    { id: 'students', label: 'Student Portal' },
    { id: 'admin', label: 'Admin Tools' },
  ];
  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <div className="p-5 border-b flex justify-between items-center bg-gradient-to-r from-green-500 to-green-600 text-white rounded-t-2xl">
          <h2 className="text-xl font-black flex items-center gap-2"><HelpCircle className="w-6 h-6" /> Green Ticket Tracker Help</h2>
          <button onClick={onClose} className="text-white/80 hover:text-white"><X className="w-6 h-6" /></button>
        </div>
        <div className="flex border-b overflow-x-auto flex-shrink-0">
          {sections.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)} className={`px-4 py-2.5 text-xs font-bold whitespace-nowrap border-b-2 transition ${activeSection === s.id ? 'border-green-500 text-green-700 bg-green-50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="p-6 overflow-y-auto flex-1 text-sm text-gray-700 space-y-4">
          {activeSection === 'overview' && (<>
            <h3 className="text-lg font-black text-gray-900">Welcome to Green Ticket Tracker!</h3>
            <p>This app helps teachers recognize and reward positive student behavior using a digital ticket system based on three core values:</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center">
                <div className="text-2xl mb-1">🤝</div>
                <div className="font-bold text-blue-800">Respectful</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
                <div className="text-2xl mb-1">📋</div>
                <div className="font-bold text-amber-800">Responsible</div>
              </div>
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 text-center">
                <div className="text-2xl mb-1">🔥</div>
                <div className="font-bold text-purple-800">Determined</div>
              </div>
            </div>
            <p>Students accumulate tickets which they can spend at the class store. Teachers can also track class-wide and grade-level goals.</p>
          </>)}
          {activeSection === 'roles' && (<>
            <h3 className="text-lg font-black text-gray-900">User Roles</h3>
            <div className="space-y-3">
              <div className="bg-green-50 rounded-xl p-4 border border-green-200">
                <div className="font-bold text-green-800 mb-1">🏠 Homeroom Teacher</div>
                <p>Manages their own class. Can give tickets to students, track spending, set class ticket goals, use Display Mode for classroom view, and add students to their roster.</p>
              </div>
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
                <div className="font-bold text-blue-800 mb-1">🎨 Specialist</div>
                <p>Can give tickets and golden tickets to students across all homerooms. Sees all classes but only their own ticket activity. Great for art, music, PE, and other specialist teachers.</p>
              </div>
              <div className="bg-red-50 rounded-xl p-4 border border-red-200">
                <div className="font-bold text-red-800 mb-1">🛡️ Administrator</div>
                <p>Full access to all features: give tickets to any class, manage the student roster (CSV import), merge duplicate students, manage teacher profiles, set grade-level goals, and view all activity across the school. Requires an admin password to register.</p>
              </div>
            </div>
            <p className="text-gray-500 italic text-xs">You can switch roles using the <strong>Role</strong> button in the navigation bar.</p>
          </>)}
          {activeSection === 'tickets' && (<>
            <h3 className="text-lg font-black text-gray-900">Giving Tickets</h3>
            <ul className="list-disc ml-5 space-y-2">
              <li><strong>Individual students:</strong> Click on a student card to select a reason (Respectful, Responsible, or Determined).</li>
              <li><strong>Whole class:</strong> Use the "Award Whole Class" button to give every student in a homeroom one ticket for the selected reason.</li>
              <li><strong>Golden Tickets:</strong> Special class-wide awards tracked separately. They count toward grade-level goals.</li>
              <li><strong>Quick tap:</strong> Tap the colored Respectful/Responsible/Determined circles on student cards for one-tap ticket giving.</li>
            </ul>
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-yellow-800 text-xs">
              <strong>Tip:</strong> Each student's balance is shown on their card. Tickets earned are never subtracted — spending uses a separate "wallet" balance.
            </div>
          </>)}
          {activeSection === 'spending' && (<>
            <h3 className="text-lg font-black text-gray-900">Spending & Class Store</h3>
            <p>Students earn a <strong>spendable balance</strong> from their tickets. Homeroom teachers can deduct points when students "buy" items from the class store.</p>
            <ul className="list-disc ml-5 space-y-2">
              <li>Tap the <strong>shopping bag icon</strong> on a student card to open the spend dialog.</li>
              <li>Enter the cost and item name (e.g., "Pencil", "Extra recess").</li>
              <li>The student's spendable balance updates automatically.</li>
              <li>Spending does <strong>not</strong> affect goal progress — goals count lifetime tickets earned.</li>
            </ul>
          </>)}
          {activeSection === 'goals' && (<>
            <h3 className="text-lg font-black text-gray-900">Goals</h3>
            <div className="space-y-3">
              <div className="bg-green-50 rounded-xl p-4 border border-green-200">
                <div className="font-bold text-green-800 mb-1">🎯 Class Ticket Goals</div>
                <p>Set by homeroom teachers. Choose a ticket target and a reward (e.g., "50 tickets → Pajama Party"). Progress is visible to students in the student portal and in Display Mode.</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
                <div className="font-bold text-amber-800 mb-1">⭐ Grade Golden Ticket Goals</div>
                <p>Set by admins in the Grade Goals tab. Track how many golden tickets a grade-level has earned toward a grade-wide reward (e.g., "10 golden tickets → Field Trip").</p>
              </div>
            </div>
          </>)}
          {activeSection === 'students' && (<>
            <h3 className="text-lg font-black text-gray-900">Student Portal</h3>
            <p>Students can log in with their <strong>Student ID</strong> and <strong>PIN code</strong> (generated during roster import) to view:</p>
            <ul className="list-disc ml-5 space-y-2">
              <li>Their ticket balance and spending history</li>
              <li>Class ticket goal progress</li>
              <li>Grade-level golden ticket goal progress</li>
              <li>Recent ticket activity</li>
            </ul>
            <p className="text-gray-500 text-xs italic">Student IDs and PINs are shown in the roster data. Teachers can share these with students as needed.</p>
          </>)}
          {activeSection === 'admin' && (<>
            <h3 className="text-lg font-black text-gray-900">Admin Tools</h3>
            <ul className="list-disc ml-5 space-y-2">
              <li><strong>Overview:</strong> School-wide stats — total tickets, breakdowns by type/teacher/class, top students, and full activity log.</li>
              <li><strong>Give Tickets:</strong> Award tickets to any class or student across the school.</li>
              <li><strong>Merge Students:</strong> Combine duplicate student profiles. All tickets transfer to the target student.</li>
              <li><strong>Teachers:</strong> View all registered teacher profiles. Delete unused profiles (0 tickets).</li>
              <li><strong>Roster Sync (CSV):</strong> Bulk import students using CSV format (name, homeroom, grade). Clear the entire roster if needed.</li>
              <li><strong>Grade Goals:</strong> Set grade-level golden ticket goals with reward descriptions.</li>
            </ul>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-blue-800 text-xs">
              <strong>CSV Format:</strong> Header row must contain <code>name</code>, <code>homeroom</code>, and <code>grade</code>. Example:<br />
              <code className="text-xs">name,homeroom,grade<br />Jane Doe, Mr. Smith, 3rd Grade</code>
            </div>
          </>)}
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-end rounded-b-2xl">
          <button onClick={onClose} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded-xl transition text-sm">Got it!</button>
        </div>
      </div>
    </div>
  );
}

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

function PrintableLoginCards({ students, onClose }) {
  return (
    <div className="printable-cards-wrapper fixed inset-0 bg-white z-[9999] overflow-y-auto p-8 font-sans text-gray-900">
      <div className="max-w-4xl mx-auto print:max-w-full">
        {/* Control bar (hidden when printing) */}
        <div className="flex justify-between items-center mb-8 border-b pb-4 print:hidden">
          <div>
            <h2 className="text-xl font-bold text-navy-950">Student Login Cards Preview</h2>
            <p className="text-sm text-gray-500">Each card contains the student's name, ID, PIN, and instructions. Cut them out to distribute.</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => window.print()}
              className="bg-brand-600 hover:bg-brand-700 text-white font-bold py-2 px-6 rounded-xl transition shadow-sm text-sm cursor-pointer"
            >
              Print Now
            </button>
            <button
              onClick={onClose}
              className="bg-gray-100 hover:bg-gray-200 text-gray-750 font-bold py-2 px-6 rounded-xl transition text-sm cursor-pointer"
            >
              Close Preview
            </button>
          </div>
        </div>

        {/* CSS Print Styles */}
        <style dangerouslySetInnerHTML={{__html: `
          @media print {
            /* Hide the main app layouts completely to prevent height clipping and pagination blank space */
            #root > div > nav,
            #root > div > main,
            #root > div > footer,
            .print\\:hidden {
              display: none !important;
            }
            /* Reset the print preview container structure so it functions like a standard flow page document */
            .printable-cards-wrapper {
              position: static !important;
              inset: auto !important;
              width: 100% !important;
              height: auto !important;
              min-height: auto !important;
              overflow: visible !important;
              padding: 0 !important;
              margin: 0 !important;
              background: transparent !important;
            }
            .print\\:break-inside-avoid {
              break-inside: avoid;
              page-break-inside: avoid;
            }
          }
        `}} />

        {/* Cards Grid */}
        <div className="printable-cards-container grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 print:grid-cols-2 print:gap-4">
          {students.map(student => (
            <div key={student.id} className="border-2 border-dashed border-brand-400 p-6 rounded-2xl bg-white shadow-xs flex flex-col justify-between min-h-[180px] print:break-inside-avoid relative overflow-hidden text-navy-950">
              {/* Decorative Corner accent */}
              <div className="absolute top-0 right-0 bg-brand-100 text-brand-700 font-black px-3 py-1 rounded-bl-xl text-[10px] tracking-wider print:border-l print:border-b print:border-brand-350 uppercase">
                Student Ticket Portal
              </div>
              
              <div>
                <span className="text-xxs font-bold text-gray-400 uppercase tracking-widest block mb-1">Student Name</span>
                <h3 className="text-lg font-black text-navy-950 leading-tight mb-3">{student.name}</h3>
              </div>

              <div className="grid grid-cols-2 gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-100 mb-3">
                <div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Student Number</span>
                  <code className="text-xs font-black text-slate-800 font-mono select-all">{student.id}</code>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">4-Digit PIN</span>
                  <code className="text-xs font-black text-brand-650 font-mono tracking-widest">{student.pinCode}</code>
                </div>
              </div>

              <div className="text-[9px] text-gray-500 leading-normal border-t pt-2.5">
                <span className="font-bold text-navy-950 block mb-0.5">How to log in:</span>
                1. Go to the ticket tracker website.<br />
                2. Select "Student Portal".<br />
                3. Enter your Student Number and 4-Digit PIN.
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
