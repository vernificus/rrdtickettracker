import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#064e3b', padding: '24px', fontFamily: 'system-ui, sans-serif', color: '#ffffff' }}>
          <div style={{ maxWidth: '440px', width: '100%', backgroundColor: '#ffffff', padding: '32px', borderRadius: '24px', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25)', textAlign: 'center', color: '#0f172a' }}>
            <h2 style={{ fontSize: '20px', fontWeight: '800', marginBottom: '8px' }}>Application Notice</h2>
            <p style={{ fontSize: '13px', color: '#475569', marginBottom: '20px', wordBreak: 'break-word', lineHeight: '1.5' }}>
              {this.state.error?.message || "An unexpected error occurred while loading this view."}
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
                style={{ padding: '10px 18px', backgroundColor: '#047857', color: '#ffffff', borderRadius: '12px', border: 'none', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem('token');
                  window.location.reload();
                }}
                style={{ padding: '10px 18px', backgroundColor: '#f1f5f9', color: '#334155', borderRadius: '12px', border: '1px solid #cbd5e1', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
              >
                Sign In Again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.log('Service Worker registration failed:', err);
    });
  });
}

