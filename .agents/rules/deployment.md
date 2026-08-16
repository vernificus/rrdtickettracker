# Deployment Rules & Production Environment

## Primary Production Environment
- **Primary Site URL**: `https://ticket-tracker-639453420405.us-east1.run.app/`
- **Target Platform**: Google Cloud Run
- **Service Name**: `ticket-tracker`
- **GCP Project**: `ticket-tracker-500200`
- **Region**: `us-east1`
- **Deploy Command**: `npm run deploy` (or `gcloud run deploy ticket-tracker --source . --region us-east1 --project ticket-tracker-500200 --quiet`)

> Note: Rolling Ridge teachers and school staff primarily use `https://ticket-tracker-639453420405.us-east1.run.app/`. When deploying changes live, always deploy to this Cloud Run service.

## Secondary / Mirror Environment
- **Mirror Site URL**: `https://rrdtickettracker.web.app/`
- **Platform**: Firebase Hosting (`school-experiments-5bc99`)
- **Automated**: Deployed automatically on git push/merge to `main` via GitHub Actions.
