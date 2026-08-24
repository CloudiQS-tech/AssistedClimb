# Assisted CLIMB — AWS Migration: Project Overview

## Client
**Dawn** (Assisted CLIMB platform owner)

## Delivered By
**Sita Thomas** — CloudiQS Technical Team

---

## 1. Project Summary

Assisted CLIMB is an AI-assisted educational platform that helps students develop metacognitive skills through structured, AI-supported learning. The platform uses a MAP → TORCH → COMPASS learning workflow where students interact with AI to plan, explore, and critically evaluate their learning.

The platform was originally built and hosted on **Replit**. This project migrated the entire application to **AWS** to provide a secure, scalable, production-ready hosting environment suitable for pilot schools.

---

## 2. What Was Delivered

| Deliverable | Status |
|-------------|--------|
| Full application migrated from Replit to AWS | ✅ Complete |
| Secure HTTPS endpoint (valid SSL certificate) | ✅ Complete |
| Custom domain: https://assistedclimb.cloudiqs.com | ✅ Complete |
| Frontend (React/Vite) deployed on ECS Fargate | ✅ Complete |
| Backend API (Node.js/Express) deployed on ECS Fargate | ✅ Complete |
| PostgreSQL database on Amazon RDS | ✅ Complete |
| Database schema auto-migration on startup | ✅ Complete |
| Platform admin access (/admin) restored | ✅ Complete |
| Application monitoring via CloudWatch | ✅ Complete |
| Basic operational logging | ✅ Complete |

---

## 3. Live URLs

| Purpose | URL |
|---------|-----|
| Application (HTTPS) | https://assistedclimb.cloudiqs.com |
| Platform Admin | https://assistedclimb.cloudiqs.com/admin |
| ALB Direct (HTTP) | http://assisted-climb-alb-674060081.eu-west-2.elb.amazonaws.com |

---

## 4. AWS Architecture

```
Internet (HTTPS)
     │
     ▼
Application Load Balancer (ALB)
  ├── HTTPS Listener (Port 443) — ACM SSL Certificate
  │     ├── /api/*, /auth/*, /health → Backend Target Group
  │     └── /* (default) → Frontend Target Group
  │
  ▼                                    ▼
ECS Fargate                      ECS Fargate
(Frontend Service)               (Backend Service)
nginx + React SPA                Node.js/Express API
     │                                  │
     │                                  ▼
     │                           Amazon RDS PostgreSQL
     │                           (Private Subnet)
     │
     └── Static assets served via nginx
```

---

## 5. AWS Services Used

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **Amazon ECS (Fargate)** | Containerised frontend and backend | Serverless containers, no EC2 management |
| **Amazon ECR** | Container image repository | Stores Docker images for both services |
| **Amazon RDS (PostgreSQL)** | Managed relational database | db.t3.micro, Single-AZ, eu-west-2 |
| **Application Load Balancer** | Traffic routing, health checks, SSL termination | HTTPS on 443, path-based routing |
| **AWS Certificate Manager (ACM)** | Free SSL/TLS certificate | Domain-validated for assistedclimb.cloudiqs.com |
| **Amazon Route 53** | DNS management | CNAME record in cloudiqs.com hosted zone |
| **Amazon VPC** | Network isolation | Database in private subnets, containers in private subnets |
| **Amazon CloudWatch** | Application logging and monitoring | Log group: /ecs/Assisted-CLIMB/backend |

---

## 6. AWS Account Details

| Item | Value |
|------|-------|
| Application AWS Account | 430367037753 |
| AWS Region | eu-west-2 (London) |
| DNS Management Account | 349440382087 (CloudiQS Route 53) |
| ECS Cluster | Assisted-CLIMB-cluster |
| Frontend Service | Assisted-CLIMB-frontend-svc |
| Backend Service | Assisted-CLIMB-backend-svc |
| RDS Instance | assisted-climb-db.cf48wiai0got.eu-west-2.rds.amazonaws.com |
| Database Name | assisted_climb |
| Current Backend Task Definition | Assisted-CLIMB-backend:18 |
| ACM Certificate ARN | arn:aws:acm:eu-west-2:430367037753:certificate/1bc9e117-bf3c-4f55-a022-a27f1c9cbc20 |

---

## 7. Application Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TailwindCSS, TypeScript |
| Backend | Node.js, Express, TypeScript, esbuild |
| Database | PostgreSQL 15 (via Drizzle ORM) |
| AI Integration | Google Gemini (per-organisation API key, encrypted at rest) |
| Authentication | Email/password with bcrypt hashing, session-based auth |
| Admin Auth | Header-based secret (x-admin-secret → PLATFORM_ADMIN_SECRET) |

---

## 8. Key Technical Decisions

### Container Strategy
- **Frontend**: Pre-built static files served by nginx:alpine (Dockerfile.frontend-simple)
- **Backend**: Pre-built JS bundle (via esbuild on host) packaged into node:20-slim (Dockerfile.backend-prebuilt)
- **Reason**: esbuild crashes under AMD64 emulation (QEMU) on Apple Silicon; native build + minimal runtime image avoids this entirely
- **Build command**: `docker buildx build --platform linux/amd64 -f Dockerfile.backend-prebuilt -t assisted-climb-backend:latest . --load`

### Database Migration
- RDS is in a private VPC (unreachable from local machine)
- Created `migrate.mjs` that runs `CREATE TABLE IF NOT EXISTS` for all 9 tables on container startup
- Tables: organisations, teachers, classes, tasks, student_sessions, stage_entries, chat_messages, teacher_feedback, audit_log

### Environment Variables
- Stored as plain ECS task definition environment variables (POC-grade)
- Special characters in DATABASE_URL password must be percent-encoded (e.g., `(` → `%28`, `<` → `%3C`, etc.)
- Task definition template: `cloudformation/task-def-backend-v6.json`

### CORS
- `ALLOWED_ORIGINS` environment variable read at runtime
- Currently: `https://assistedclimb.cloudiqs.com`

---

## 9. Deployment Process

### Backend Rebuild & Deploy
```bash
# 1. Login to AWS SSO
aws sso login --sso-session cloudiqs

# 2. Build JS bundle natively on Mac (avoids esbuild emulation crash)
cd Climb-Assistant && pnpm install --no-frozen-lockfile
cd artifacts/api-server && pnpm run build && cd ../..

# 3. Build AMD64 Docker image using pre-built bundle
docker buildx build --platform linux/amd64 -t assisted-climb-backend:latest -f Dockerfile.backend-prebuilt . --load

# 4. Login to ECR, tag, and push
aws ecr get-login-password --region eu-west-2 --profile sandbox | docker login --username AWS --password-stdin 430367037753.dkr.ecr.eu-west-2.amazonaws.com
docker tag assisted-climb-backend:latest 430367037753.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb-backend:latest
docker push 430367037753.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb-backend:latest

# 5. Force new deployment
aws ecs update-service --cluster Assisted-CLIMB-cluster --service Assisted-CLIMB-backend-svc --force-new-deployment --region eu-west-2 --profile sandbox
```

### Task Definition Updates (env var changes)
```bash
# Edit cloudformation/task-def-backend-v6.json, then:
aws ecs register-task-definition --cli-input-json file://cloudformation/task-def-backend-v6.json --region eu-west-2 --profile sandbox
aws ecs update-service --cluster Assisted-CLIMB-cluster --service Assisted-CLIMB-backend-svc --task-definition Assisted-CLIMB-backend:<NEW_REVISION> --force-new-deployment --region eu-west-2 --profile sandbox
```

---

## 10. Estimated Monthly Cost

| Service | Approx Cost |
|---------|-------------|
| ECS Fargate (2 services, minimal) | ~$18–25 |
| RDS PostgreSQL (db.t3.micro) | ~$15 |
| Application Load Balancer | ~$20 |
| CloudWatch Logs | ~$3 |
| Route 53 + ACM | ~$1 |
| **Total** | **~$60–65/month** |

Well under the $100/month POC budget target.

---

## 11. Domain Strategy

- **Current**: `assistedclimb.cloudiqs.com` — subdomain of CloudiQS-owned domain, DNS managed in Route 53 (account 349440382087)
- **Future**: A dedicated domain (e.g., `assistedclimb.com` — confirmed available) can be registered and pointed at the same ALB with a new ACM certificate
- **Transferability**: Domain and infrastructure ownership can be transferred to the client's own AWS account at any time

---

## 12. What's Working End-to-End

- ✅ Teacher registration and login
- ✅ Class creation with generated join codes
- ✅ Task creation within classes
- ✅ Student joining via class code (incognito/separate browser)
- ✅ Student sessions visible in Teacher view
- ✅ Platform admin dashboard (/admin) with organisation management
- ✅ Organisation creation, activation/deactivation
- ✅ IT Admin creation and password reset
- ✅ AI key configuration per organisation (Gemini / Azure)
- ✅ HTTPS with valid SSL certificate (no browser warnings)

---

## 13. Known POC Limitations (Future Hardening)

| Item | Current State | Production Recommendation |
|------|---------------|--------------------------|
| Secrets | Plain env vars in task definition | AWS Secrets Manager with rotation |
| Database | Single-AZ, no failover | Multi-AZ RDS for 99.95% uptime |
| CI/CD | Manual build + push | GitHub Actions or CodePipeline |
| Scaling | Fixed 1 task per service | Auto-scaling policies based on CPU/memory |
| Site gate | SITE_PASSWORD = "CatsandDogs" (enabled) | Remove or change for production |
| Backups | RDS automated backups (7-day) | Add cross-region backup replication |
| CDN | Not configured | CloudFront for static asset delivery |
| WAF | Not configured | AWS WAF for DDoS and bot protection |

---

## 14. Key Files

| File | Purpose |
|------|---------|
| `Climb-Assistant/Dockerfile.frontend-simple` | Frontend container (nginx + pre-built static) |
| `Climb-Assistant/Dockerfile.backend-prebuilt` | Backend container (node + pre-built dist/) |
| `Climb-Assistant/artifacts/api-server/migrate.mjs` | Database schema auto-migration |
| `Climb-Assistant/artifacts/api-server/src/app.ts` | Express app with CORS config |
| `Climb-Assistant/artifacts/api-server/src/routes/admin.ts` | Admin API routes |
| `Climb-Assistant/set-admin-secret.sh` | Deploy script (task def with admin secret) |
| `Climb-Assistant/build-backend-and-deploy.sh` | Full backend build + deploy script |
| `Climb-Assistant/nginx.conf` | Frontend nginx configuration |
| `EMAIL_TO_DAWN.md` | Client communication (deployment notification) |

---

## 15. Timeline

| Date | Milestone |
|------|-----------|
| Late July 2025 | Infrastructure provisioned (VPC, ECS, RDS, ALB) |
| Early August 2025 | Frontend and backend containers deployed |
| 5 August 2025 | HTTPS enabled via ACM + custom domain live |
| 5 August 2025 | Client notified — testing URL shared |
| 6 August 2025 | Admin access restored (PLATFORM_ADMIN_SECRET) |
| August 2025 | Pilot testing with Dawn |
| 18 August 2026 | Deployment issues resolved (arch mismatch, CORS, DB URL encoding) |
| 18 August 2026 | All reported bugs (Errors 1–4) and admin features confirmed deployed |

---

## 16. Resolved Issues (18 Aug 2026)

| Issue | Root Cause | Fix Applied |
|-------|-----------|-------------|
| Site gate showing "Incorrect password" (500) | Docker image built for ARM, not AMD64 | Rebuilt with `--platform linux/amd64` using `Dockerfile.backend-prebuilt` |
| Container crash: `exec format error` | ARM binary on x86_64 Fargate | AMD64 build (above) |
| Container crash: `Cannot find module init-db.mjs` | Wrong CMD in Dockerfile | Changed to `dist/index.mjs` |
| CORS blocking POST requests | `ALLOWED_ORIGINS` not set | Added `https://assistedclimb.cloudiqs.com` to task def |
| DATABASE_URL parsing failure | Special chars not URL-encoded | Percent-encoded password in connection string |

## 17. Bug/Feature Status (Dawn's Email)

| Item | Status | Notes |
|------|--------|-------|
| Admin "Forgot password?" | ✅ Implemented | Uses recovery key (SESSION_SECRET) |
| Admin "Log out" button | ✅ Implemented | In admin header |
| Admin "Change password" | ✅ Implemented | "Change Secret" form in admin header |
| Error 1: Tasks don't save | ✅ Fixed | PUT /teacher/classes/:classId/task with upsert |
| Error 2: AI not working in Torch | ⚠️ Requires config | Organisation needs Gemini API key configured via admin panel |
| Error 3: Student work doesn't auto-save | ✅ Fixed | 1.5s debounced auto-save for all stages |
| Error 4: Teacher locked out after student joins | ✅ Fixed | Sessions now coexist (teacherId preserved) |

## 18. Next Steps

1. **Configure AI key** — Set Gemini API key for the organisation via Platform Admin panel (no deploy needed)
2. **Move to customer account** — Deploy infrastructure to client's own AWS account (~2-3 hours)
3. **Dedicated domain** — Register `assistedclimb.com` (or client's preferred name) and attach
4. **Pilot schools** — Onboard pilot school(s)
5. **Production hardening** — Move secrets to Secrets Manager, enable auto-scaling, add WAF

---

*Document prepared by Sita Thomas — CloudiQS*  
*Last updated: 18 August 2026*
