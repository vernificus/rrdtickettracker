# Rolling Ridge Elementary School - PBIS Green Ticket Tracker

PBIS Green Ticket Tracker web application for Rolling Ridge Elementary School students, teachers, and staff (Loudoun County Public Schools).

---

## 🚀 Live Deployment Information

> [!IMPORTANT]
> **PRIMARY LIVE DEPLOYMENT SITE FOR TEACHERS & STAFF:**
> **URL**: [https://ticket-tracker-639453420405.us-east1.run.app/](https://ticket-tracker-639453420405.us-east1.run.app/)
>
> This Google Cloud Run service is the **primary production environment** used daily by Rolling Ridge teachers and school staff. Whenever changes or fixes are ready for production, they must be deployed to this Cloud Run service.

### Deployment Targets:
1. **Primary Production (Google Cloud Run)**:
   - **URL**: `https://ticket-tracker-639453420405.us-east1.run.app/`
   - **GCP Project**: `ticket-tracker-500200`
   - **Service Name**: `ticket-tracker`
   - **Region**: `us-east1`
   - **Deploy Command**:
     ```bash
     npm run deploy
     # or
     gcloud run deploy ticket-tracker --source . --region us-east1 --project ticket-tracker-500200 --quiet
     ```

2. **Secondary / Mirror (Firebase Hosting)**:
   - **URL**: `https://rrdtickettracker.web.app/`
   - **Firebase Project**: `school-experiments-5bc99`
   - **Hosting Target**: `rrdtickettracker`
   - **Automated**: Deploys automatically on merge/push to `main` branch via GitHub Actions (`.github/workflows/firebase-hosting-merge.yml`).

---

## 🛠️ Development & Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Local Development Server
```bash
npm run dev
```
Accessible locally at `http://localhost:5173/`.

### 3. Build Production Bundle
```bash
npm run build
```

### 4. Run Production Server Locally
```bash
npm start
```
Runs the Express backend on `http://localhost:8080/`.

---

## 📦 Project Architecture
- **Frontend**: React 19, Vite, Tailwind CSS, Lucide React icons.
- **Backend API**: Node.js / Express (`server.cjs`) with Google Sheets integration and local fallback database.
- **Container**: Multi-stage `Dockerfile` running Node.js Alpine on Google Cloud Run.
