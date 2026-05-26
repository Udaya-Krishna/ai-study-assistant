# AI Study Assistant

## Setup

### Prerequisites
- Node 18+
- Python 3.11+
- AWS CLI v2
- AWS CDK v2

### Install dependencies

#### Frontend
cd frontend && npm install

#### Backend (run inside each folder)
cd backend/embed && pip install -r requirements.txt -t .
cd backend/upload && pip install -r requirements.txt -t .
cd backend/summary && pip install -r requirements.txt -t .
cd backend/quiz && pip install -r requirements.txt -t .
cd backend/chat && pip install -r requirements.txt -t .

#### Infrastructure
cd infrastructure && npm install

### Environment Variables
Copy .env.example to .env and fill in your values.

### Deploy
cd infrastructure && cdk deploy