# Assisted Climb — Development Effort Estimate

**Project:** Security Enhancement & Feature Implementation  
**Prepared by:** Sita Thomas  
**Date:** 21 August 2026  
**Resources:** 1 Developer + AI-Assisted Development (Kiro)  
**Total Duration:** 10 Working Days

---

## 1. Effort Summary

| Metric | Value |
|---|---|
| Total requirements | 27 |
| New features | 17 |
| Enhancements to existing features | 7 |
| Bug fixes | 3 |
| Already implemented (no work needed) | 1 |
| **Net items to deliver** | **26** |
| **Working days** | **10** |
| **Hours per day** | **8** |
| **Total development hours** | **80** |

---

## 2. Effort Breakdown by Requirement

### A. CIG Administrator (Total: 12 hours / 1.5 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| A1 | Two-step authentication for CIG admin login | New feature | 4h | New `cig_admins` table, email/password login endpoint, mandatory TOTP verification, replace shared-secret auth |
| A2 | Authenticator recovery codes | New feature | 3h | `recovery_codes` table, generate 10 codes at MFA setup, bcrypt hash storage, single-use consumption endpoint |
| A3 | Password-recovery security (keep 2FA, restrict retries, notify) | Enhancement | 3h | Add TOTP step to reset flow, attempt counter on recovery codes, SNS/email notification to CIG |
| A4 | Recovery-code rotation | New feature | 1h | Endpoint to regenerate codes, invalidate previous set |
| A5 | Permanent school deletion | New feature | 1h | Cascading delete endpoint (org → teachers → classes → students → all data), confirmation response with deletion summary |

**Existing foundation:** Shared-secret admin auth exists, TOTP library (otplib) already in use, email sending configured.

---

### B. School IT Administrator (Total: 10 hours / 1.25 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| B1 | Force initial password change | Bug fix | 1h | Ensure `mustChangePassword: true` set on all IT admin creation paths, add middleware enforcement |
| B2 | Fix email-domain restriction | Bug fix | 2h | Investigate and fix `allowedEmailDomains` persistence, verify validation on registration |
| B3 | Teacher email verification | New feature | 4h | `emailVerified` column, verification token generation, SES email with link, gating middleware, resend endpoint |
| B4 | Permanent teacher-account deletion | New feature | 3h | Cascade delete endpoint (teacher → classes → students → stage entries → chat messages), warning response listing all data to be removed |

**Existing foundation:** `mustChangePassword` field exists, `allowedEmailDomains` field exists (just buggy), SES email sending works, teacher table exists with all relationships.

---

### C. Teacher Login Security (Total: 10 hours / 1.25 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| C1 | Force TOTP enrolment | Enhancement | 3h | Middleware gate blocking access if `totpEnabled === false`, TOTP setup endpoint (QR generation, secret storage, verification step) |
| C2 | Teacher authenticator recovery | New feature (shared) | 2h | Reuse recovery-code system from A2, add teacher-specific consumption endpoint, device revocation + replacement flow |
| C3 | Strengthen passwords (12 chars, breach check, no reuse of 5) | New feature | 4h | `password_history` table, Zod schema update to 12 chars, HaveIBeenPwned k-anonymity API integration, history check on password change |
| C4 | Improve password resets | Enhancement | 1h | Ensure admin-initiated resets always set `mustChangePassword: true`, verify self-service flow already forces new password |

**Existing foundation:** TOTP fully implemented (just optional), bcrypt password hashing at cost 12, password change endpoint exists, `mustChangePassword` field exists.

---

### D. Student Login Security (Total: 16 hours / 2 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| D1 | Teacher approval of new student accounts | New feature | 8h | Add `status` enum (pending/approved/rejected) to `student_sessions`, modify join flow to set pending, block access until approved, teacher approval/rejection endpoints, bulk approve, teacher notification |
| D2 | Registration-status messages | Enhancement | 1h | Return "awaiting approval" for pending status on join attempt, "rejected" message for rejected status |
| D3 | Delete rejected registrations | Enhancement | 1h | Auto hard-delete student record on teacher rejection |
| D4 | Increase PINs to six digits | Enhancement | 2h | Change Zod validation to `^\d{6}$`, null existing PIN hashes to force re-set, update join flow messaging |
| D5 | Two-tier incorrect-PIN controls | Enhancement | 2h | Tier 1: 5-minute cooldown after 3 attempts, Tier 2: full lock after 5 attempts (teacher unlock required) |
| D6 | Separate unlock and PIN reset | Already done | 0h | Already implemented — `unlock-pin` and `reset-pin` are separate endpoints |

**Existing foundation:** Student join flow works, PIN hashing with bcrypt exists, single-tier lockout (5 attempts/15 min) exists, teacher unlock and reset endpoints exist separately.

---

### E. Classes and Climbs (Total: 12 hours / 1.5 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| E1 | Change class code | New feature | 3h | Endpoint to regenerate 6-char code, keep existing students via `classId` FK, invalidate old code immediately |
| E2 | Class-archive function | New feature | 5h | Add `archivedAt` timestamp to classes, middleware guard blocking writes on archived classes, guard on student join, guard on AI chat, guard on stage entry writes |
| E3 | Summative-assessment lock | New feature | 4h | Add `lockedAt`/`lockedBy` to student sessions, teacher lock/unlock endpoint, guards on student write endpoints, guard on AI chat endpoint |

**Existing foundation:** Class CRUD exists, class code generation exists, student write endpoints exist with middleware, AI chat endpoint exists with session validation.

---

### F. Sessions (Total: 8 hours / 1 day)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| F1 | Automatic logout (all user types) | New feature | 6h | Client-side inactivity timer (track mouse/keyboard/touch), warning modal at 10 min, auto-save current work, logout at 12 min, applies to all 4 user types with type-specific save logic |
| F2 | Secure browser session expiry | Enhancement | 2h | Remove `maxAge` from cookie (session cookie dies with browser), reduce server-side session TTL, ensure inactivity limit enforced server-side via last-activity tracking |

**Existing foundation:** Session store in PostgreSQL with rolling 8-hour expiry, logout endpoint exists, session middleware exists for all user types.

---

### G. Permanent Deletion (Total: 6 hours / 0.75 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| G1 | Permanent student deletion | New feature | 6h | Full cascade delete: student session → stage entries → chat messages → AI interactions → research logs → feedback → any linked records. Audit log entry recording what was deleted. Endpoint for teacher to trigger with confirmation. |

**Existing foundation:** Database relationships defined with FKs, class deletion with cascade already exists (as a pattern to follow), audit logging exists.

---

### Other (Total: 4 hours / 0.5 days)

| # | Requirement | Type | Hours | What's being built |
|---|---|---|---|---|
| O1 | Terminate sessions on security changes | New feature | 4h | On password reset/change: delete all sessions for that teacher from `session` table, invalidate `loginToken`. On TOTP recovery/replacement: same. Identify all trigger points (4–5 endpoints) and add session purge logic. |

**Existing foundation:** Sessions stored in PostgreSQL (`connect-pg-simple`), `loginToken` field exists, audit logging exists for all security events.

---

## 3. Day-by-Day Implementation Schedule

| Day | Focus Area | Items | Hours | Deliverable |
|---|---|---|---|---|
| **Day 1** | CIG Admin Auth | A1, A2 | 7h | CIG admin accounts with mandatory TOTP, recovery codes generated at setup |
| **Day 2** | CIG Recovery + Teacher Auth | A3, A4, A5, C1 | 8h | Recovery security hardened, school deletion, teacher TOTP enforcement |
| **Day 3** | Teacher Security | C2, C3, C4, O1 | 8h | Teacher recovery codes, password strengthening, session termination |
| **Day 4** | Student Approval (core) | D1 | 8h | Student approval workflow — pending state, approval/rejection endpoints, access blocking |
| **Day 5** | Student Security | D2, D3, D4, D5 | 6h | Status messages, rejection delete, 6-digit PINs, two-tier lockout |
| **Day 6** | School IT Admin | B1, B2, B3, B4 | 8h | Force password change, domain fix, email verification, teacher deletion |
| **Day 7** | Classes & Climbs | E1, E2 | 8h | Class code regeneration, archive function with read-only guards |
| **Day 8** | Assessment + Deletion | E3, G1 | 8h | Summative lock, permanent student deletion cascade |
| **Day 9** | Sessions | F1, F2 | 8h | Inactivity timeout (client + server), secure browser session expiry |
| **Day 10** | Integration & Verification | All | 8h | End-to-end testing, edge case fixes, final verification of all 26 items |

---

## 4. Effort Distribution

### By Work Type

| Type | Items | Hours | % of Total |
|---|---|---|---|
| New features (building from scratch) | 17 | 54h | 68% |
| Enhancements (extending existing code) | 7 | 15h | 19% |
| Bug fixes | 3 | 5h | 6% |
| Integration testing & verification | — | 6h | 7% |
| **Total** | **27** | **80h** | **100%** |

### By Effort Size

| Size | Items | Description |
|---|---|---|
| Large (6–8h) | 3 | Student approval workflow, inactivity timeout, permanent student deletion |
| Medium (3–5h) | 9 | CIG admin TOTP, recovery codes, email verification, password strengthening, class archive, assessment lock, etc. |
| Small (1–2h) | 11 | PIN upgrade, lockout tiers, password reset fix, domain fix, code regeneration, etc. |
| Zero (already done) | 1 | Separate unlock/reset |

### By Section

```
A. CIG Administrator        ████████████░░░░░░░░  12h (15%)
B. School IT Admin           ██████████░░░░░░░░░░  10h (12.5%)
C. Teacher Login Security    ██████████░░░░░░░░░░  10h (12.5%)
D. Student Login Security    ████████████████░░░░  16h (20%)
E. Classes and Climbs        ████████████░░░░░░░░  12h (15%)
F. Sessions                  ████████░░░░░░░░░░░░   8h (10%)
G. Permanent Deletion        ██████░░░░░░░░░░░░░░   6h (7.5%)
Other                        ████░░░░░░░░░░░░░░░░   4h (5%)
Testing & Verification       ██░░░░░░░░░░░░░░░░░░   2h (2.5%)
                                                   ─────
                                                   80h (100%)
```

---

## 5. What Already Exists (Reduces Effort)

The following infrastructure is already built and functional, which significantly reduces implementation time:

| Existing Capability | How It Helps |
|---|---|
| TOTP implementation (otplib + verify) | Don't need to build MFA from scratch — extend existing code |
| bcrypt password hashing (cost 12) | Password storage pattern established |
| PostgreSQL session store | Session termination is a DB query, not a new system |
| Amazon SES email sending | Email verification just needs a new template + token, not email infrastructure |
| Rate limiting middleware | Already protects auth endpoints |
| Audit logging | Just need to add new event types |
| Student PIN system (hash + lockout) | Upgrade from 4→6 digits and adjust lockout tiers |
| `mustChangePassword` field + flow | Force-change already works, just needs consistent setting |
| Class CRUD with cascade delete | Pattern exists for class deletion — extend to teacher/school |
| Express middleware pattern | All guards follow the same pattern — fast to implement |

---

## 6. What's New (Most Effort Goes Here)

| New System | Why It Takes Time |
|---|---|
| CIG admin accounts | Entirely new user type with its own table, login flow, and MFA |
| Recovery codes | New table, generation logic, hashed storage, consumption, rotation |
| Student approval workflow | Changes the core student join flow — requires pending state, teacher queue, and access blocking |
| Password history | New table + check logic on every password change |
| Class archive | Read-only guards must be added to every student write endpoint (5–6 places) |
| Inactivity timeout | Client-side timer + server coordination + auto-save before logout |
| Full cascade deletion | Must map every FK relationship and delete in correct order without orphans |

---

## 7. Risk Factors That Could Extend Timeline

| Risk | Could add | Mitigation |
|---|---|---|
| Email-domain bug harder than expected | +0.5 days | Timebox to 2h; if complex, fix persistence only and note UI issue for follow-up |
| Student approval workflow UX complications | +0.5 days | Build backend first, minimal frontend — polish post-pilot |
| Inactivity timer conflicts with AI streaming | +0.5 days | Add exception for active AI chat responses |
| HaveIBeenPwned API integration issues | +0.25 days | Fall back to local common-password list if API unreliable |
| Cascade deletion misses FK relationships | +0.25 days | Map all FKs on Day 7 morning before implementing |

**Buffer built into Day 10** — the testing day also serves as overflow if any item takes longer.

---

## 8. Delivery Approach

### How AI-Assisted Development Enables 10-Day Delivery

Traditional development for this scope: 14–16 weeks (1 developer).  
AI-assisted development: 10 days (1 developer + Kiro).

| Activity | Traditional | With Kiro |
|---|---|---|
| Writing boilerplate (schemas, routes, middleware) | Manual | Kiro generates, developer reviews |
| Database migration scripts | Manual | Kiro generates from schema analysis |
| Implementing business logic | Manual | Kiro writes first pass, developer refines |
| Writing test assertions | Manual | Kiro generates based on requirements |
| Edge case handling | Developer thinks through each | Kiro identifies from codebase patterns |
| Code consistency | Manual review | Kiro matches existing project style |

### Quality Assurance

Despite accelerated delivery:
- All code follows existing project patterns and conventions
- Security-critical logic is reviewed by the developer before merging
- Integration verification on Day 10 catches cross-feature issues
- Audit logging captures all security events for post-delivery review

---

## 9. Assumptions

1. Developer has full access to the AWS environment and codebase
2. No external dependencies block progress (client approvals, third-party APIs)
3. Frontend changes are functional (working forms/flows) not polished UI
4. Existing test infrastructure can be used for verification
5. The pilot runs with under 10 schools (limits edge cases)
6. Client feedback and revision rounds happen post-delivery, not during the 10 days

---

## 10. Deliverables After 10 Days

| # | Deliverable | Status |
|---|---|---|
| 1 | All 26 requirements implemented (backend + functional frontend) | Complete |
| 2 | Database migrations for all new tables and schema changes | Complete |
| 3 | API documentation for new endpoints | Complete |
| 4 | Audit logging for all security events | Complete |
| 5 | Integration verification report | Complete |
| 6 | Updated environment configuration (new secrets, SES templates) | Complete |
| 7 | UI polish and visual refinement | Post-pilot follow-up |
| 8 | Penetration testing | Recommended post-delivery |
| 9 | Load testing at scale | Post-pilot |

---

*End of document.*
