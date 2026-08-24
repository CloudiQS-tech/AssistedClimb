# Assisted Climb — Security Enhancement Implementation Plan

**Prepared for:** Assisted Climb Project Team  
**Prepared by:** Sita Thomas  
**Date:** 21 August 2026  
**Version:** 2.0  
**Delivery window:** 10 working days (pilot phase)

---

## 1. Executive Summary

This document outlines the implementation plan for 27 security enhancements and feature additions to the Assisted Climb platform. These changes address authentication hardening, student safeguarding, data protection (permanent deletion), session management, and classroom controls.

The work spans all user tiers (CIG administrators, School IT administrators, Teachers, and Students) and introduces new AWS services to support the enhanced security posture.

**Total items:** 27 requirements (17 new features, 7 enhancements, 3 bug fixes)  
**Delivery timeline:** 10 working days  
**AWS additional monthly cost:** ~£12–20/month on top of existing infrastructure

---

## 2. Current State Assessment

Before detailing the plan, it's important to note what **already exists** in the codebase:

| Capability | Current State |
|---|---|
| TOTP (authenticator app) | Implemented for teachers, but optional |
| Password hashing | bcrypt with cost factor 12 (teachers) and 10 (students) |
| Account lockout | 5 failed attempts → 15-min lock (teachers and students) |
| Rate limiting | Auth endpoints: 10/15min, Student join: 20/15min |
| Session store | PostgreSQL with 8-hour rolling expiry |
| Student PIN system | 4-digit, hashed, with lockout and teacher reset/unlock (separate) |
| Password reset | Email-based with 1-hour token expiry |
| Audit logging | All auth events logged to database |
| Email sending | Amazon SES configured and functional |

This means a significant portion of the infrastructure is in place. The work is primarily **extending and tightening** existing systems rather than building from scratch.

---

## 3. Detailed Implementation Plan

### Phase 1: Authentication & Identity Hardening (Days 1–4)

#### A. CIG Administrator Authentication

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| A1 | Two-step authentication for CIG admin login | Create `cig_admins` table with individual accounts (email, password hash, TOTP secret). Implement login with mandatory TOTP at every login. Replace shared-secret authentication. | 2 days |
| A2 | Authenticator recovery codes | Generate 10 single-use recovery codes at MFA setup. Store as bcrypt hashes. Allow one-time consumption as alternative to TOTP. Display codes once at setup. | 1 day |
| A3 | Password-recovery security | Add TOTP verification to reset flow. Track failed recovery-code attempts (max 3 before lockout). Send notification to CIG when recovery is used. | 0.5 days |
| A4 | Recovery-code rotation | Endpoint to regenerate fresh codes, invalidating all previous codes. | 0.25 days |
| A5 | Permanent school deletion | Cascading hard-delete: Organisation → Teachers → Classes → Students → Stage Entries → Chat Messages → Audit Logs. Confirmation with data summary. | 0.5 days |

#### C. Teacher Login Security

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| C1 | Force TOTP enrolment | Middleware gate redirecting unenrolled teachers to TOTP setup. QR code generation, manual key entry, verification before activation. | 1 day |
| C2 | Teacher authenticator recovery | Reuse recovery-code system from A2. Teacher-specific endpoint for code consumption and device replacement. | 0.5 days (shared) |
| C3 | Strengthen teacher passwords | Min 12 characters. HaveIBeenPwned k-anonymity check. `password_history` table preventing reuse of last 5 passwords. | 1 day |
| C4 | Improved password resets | Ensure all admin-initiated resets set `mustChangePassword: true`. | 0.25 days |

#### Other: Session Termination

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| O1 | Terminate sessions on security changes | On password reset, TOTP recovery, or device replacement: invalidate login token + delete all sessions for that user from PostgreSQL session store. | 0.5 days |

> **Phase 1 Deliverable:** All authentication flows hardened with MFA, recovery codes, and password policies enforced.

---

### Phase 2: Student Safeguarding & School Administration (Days 4–7)

#### D. Student Login Security

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| D1 | Teacher approval of new students | Add `status` field (pending/approved/rejected) to `student_sessions`. Block platform access until approved. Teacher approval queue with bulk-approve capability. | 2 days |
| D2 | Registration-status messages | Return clear messages: "Awaiting teacher approval" for pending, appropriate message for rejected. Display on login attempts. | 0.25 days |
| D3 | Delete rejected registrations | Hard-delete the pending record on teacher rejection. | 0.25 days |
| D4 | Increase PINs to six digits | Change validation to 6-digit minimum. Null existing PIN hashes to force re-set on next login. | 0.5 days |
| D5 | Two-tier PIN lockout | Tier 1: 5-minute cooldown after 3 incorrect attempts. Tier 2: Full lock (teacher unlock required) after 5 attempts. | 0.5 days |
| D6 | Separate unlock and PIN reset | Already implemented. Verify and document. | 0 days |

#### B. School IT Administrator

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| B1 | Force initial password change | Set `mustChangePassword: true` on all IT admin creation paths. Enforce in middleware. | 0.25 days |
| B2 | Fix email-domain restriction | Investigate persistence bug with `allowedEmailDomains`. Fix save and validation. | 0.5 days |
| B3 | Teacher email verification | Add `emailVerified` column. Send verification link via SES. Block access until verified. Resend endpoint. | 1 day |
| B4 | Permanent teacher deletion | School admin deletes teacher → cascade through classes → students → all work. Confirmation with deletion preview. | 1 day |

> **Phase 2 Deliverable:** Student registration gated by teacher approval, PINs hardened, teacher accounts verified and manageable.

---

### Phase 3: Classroom Controls & Data Protection (Days 7–9)

#### E. Classes and Climbs

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| E1 | Change class code | Regenerate 6-character code. Existing students keep access. Old code immediately invalidated. | 0.5 days |
| E2 | Class-archive function | Add `archivedAt` to classes. Block all writes, AI interactions, and new registrations on archived classes. Read-only access preserved. | 1 day |
| E3 | Summative-assessment lock | Add `lockedAt`/`lockedBy` per student climb. Block edits, deletions, and AI chat when locked. View access preserved. | 1 day |

#### G. Permanent Deletion

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| G1 | Permanent student deletion | Full cascade: student session → stage entries → chat messages → AI interactions → research logs → feedback → linked records. Audit trail of deletion event. | 1 day |

> **Phase 3 Deliverable:** Teachers control class lifecycle, student work lockable for assessment, all deletion cascades functional.

---

### Phase 4: Session Management & Testing (Days 9–10)

#### F. Sessions

| # | Requirement | Implementation | Effort |
|---|---|---|---|
| F1 | Automatic logout (all user types) | Client-side inactivity timer: warning at threshold, auto-save + logout after grace period. Server-side session TTL reduction. | 1 day |
| F2 | Secure browser session expiry | Reconfigure cookies so browser close doesn't leave indefinite session. Inactivity limit applies regardless. | 0.5 days |

#### Integration Verification

| # | Activity | Details | Effort |
|---|---|---|---|
| T1 | End-to-end verification | Test all flows per user type: CIG admin login, teacher TOTP setup, student approval, PIN changes, archive, lock, deletion, timeout. | 0.5 days |

> **Phase 4 Deliverable:** Sessions managed securely, all features integration-verified and pilot-ready.

---

## 4. Technical Recommendations & Considerations

The following recommendations are based on analysis of the current codebase and practical experience with similar education platforms. These are suggestions to ensure the best outcome for the pilot — not blockers — and should be discussed before implementation begins.

### Concern 1: CIG Admin Individual Accounts — Scope for Pilot

**Issue:** Building a full CIG admin user system (new table, login flow, MFA, recovery) is significant work for what may be 1–2 users in the pilot.

**Current state:** CIG admin access uses a shared secret in a header. This is simple but lacks individual accountability.

**Recommendation:** For the pilot, add TOTP as a second factor on top of the existing shared-secret mechanism. This delivers two-step authentication without the overhead of individual account management. Full individual accounts can follow post-pilot when there are more admin users.

**Impact if accepted:** Saves ~1 day of implementation effort.

---

### Concern 2: HaveIBeenPwned Integration — External Dependency

**Issue:** The k-anonymity API is well-designed, but it introduces an external dependency. If the API is unreachable, password changes could fail.

**Recommendation:** Implement as a **soft check** (warning to user: "This password has appeared in data breaches — we recommend choosing a different one") rather than a hard block for the pilot. Upgrade to a hard block in production once you've confirmed the API's availability meets your uptime requirements.

**Impact if accepted:** Reduces risk of pilot disruption with no security regression.

---

### Concern 3: Student Approval Workflow — Classroom UX Risk

**Issue:** Currently students join instantly with a class code. Adding a mandatory approval step means:
- Students wait (frustrating during a live lesson)
- Teachers get an approval queue to manage (extra admin)
- If a teacher forgets to check, students cannot work

This is the right safeguarding decision, but poor UX will frustrate pilot users and generate negative feedback.

**Recommendation:** Implement the approval workflow as specified, but additionally provide:
1. **Bulk approve** — one click to approve all pending students
2. **"Lesson mode"** toggle — teacher can temporarily enable auto-approval during a class session, then revert to gated mode afterwards
3. **Real-time notification** — alert the teacher immediately when a student is waiting (in-app badge or browser notification)

**Impact if accepted:** Adds ~0.5 days but significantly reduces risk of pilot friction.

---

### Concern 4: 10-Minute Inactivity Timeout — Too Aggressive for Education

**Issue:** 10 minutes is very short in a classroom context. Students may be:
- Reading printed materials or worksheets
- Writing on paper before typing up
- In a group discussion
- Watching the teacher demonstrate on the board

A 10-minute timeout will interrupt genuine work sessions, leading to frustration and data loss anxiety (even with auto-save).

**Recommendation:** Make the timeout configurable per organisation:
- **Default for admin/teacher accounts:** 10 minutes (as specified)
- **Default for student accounts:** 20 minutes (more realistic for classroom use)
- **Configurable by school IT admin:** Allow schools to adjust the student timeout between 10–30 minutes based on their use patterns

**Impact if accepted:** No additional effort (just a config value instead of a hardcoded one). Significant improvement in pilot experience.

---

### Concern 5: Teacher Recovery Codes — Practical Support Concern

**Issue:** Teachers are not security professionals. Experience shows that many users lose their recovery codes within weeks of setup. This will generate support requests to CIG.

**Recommendation:** In addition to recovery codes, implement an **IT admin MFA override** — the school IT administrator can reset a teacher's TOTP enrolment (clearing `totpSecret` and `totpEnabled`), forcing the teacher to re-enrol on next login. This provides a safety valve that doesn't require CIG intervention for every lost device.

**Impact if accepted:** Adds ~0.25 days. Significantly reduces ongoing support burden.

---

### Concern 6: Permanent Deletion Without Grace Period

**Issue:** The requirements specify "permanent deletion" but do not mention a grace period. An accidental deletion (especially of a school with all its data) is catastrophic and irreversible.

**Recommendation:** Implement a **30-day soft-delete** before hard deletion:
1. On "delete" action: mark record as deleted, hide from all views, stop all access
2. After 30 days: automated job permanently removes the data
3. Within 30 days: CIG can reverse the deletion if it was accidental

For the pilot: implement the soft-delete with immediate hard-delete available as a separate admin action if truly needed.

**Impact if accepted:** Adds ~0.5 days. Prevents irreversible data loss accidents.

---

---

## 5. New AWS Services Required

| AWS Service | Purpose | Monthly Cost |
|---|---|---|
| **Amazon SES** (Simple Email Service) | Teacher email verification, password reset emails, recovery notifications, approval alerts | £1–3/month |
| **AWS Secrets Manager** (additional secrets) | TOTP encryption keys, recovery-code salt | £2–3/month |
| **Amazon CloudWatch** (enhanced alarms) | Security event monitoring: failed login spikes, lockouts, deletion events | £3–5/month |
| **AWS WAF** (Web Application Firewall) | Edge-level rate limiting, brute-force protection for auth endpoints | £7–10/month |
| **Amazon SNS** (Simple Notification Service) | Real-time alerts to CIG on recovery usage, lockouts, deletions | £1–2/month |

### Services already in use (no additional cost):

| Existing Service | Extended Usage |
|---|---|
| Amazon RDS PostgreSQL | New tables + schema changes (no instance size increase needed for pilot) |
| Amazon ECS / Fargate | All logic runs in existing API container |
| Application Load Balancer | No changes |
| Amazon S3 / CloudFront | No changes |
| AWS Certificate Manager | No changes |

**Total additional AWS cost: ~£12–20/month**

---

## 6. Database Changes

### New Tables

| Table | Purpose |
|---|---|
| `cig_admins` | Individual CIG admin accounts (email, password hash, TOTP secret, created_at) |
| `recovery_codes` | Hashed single-use backup codes linked to user (polymorphic: CIG admin or teacher) |
| `password_history` | Last 5 password hashes per teacher for reuse prevention |

### Schema Modifications

| Table | Changes |
|---|---|
| `teachers` | Add: `email_verified`, `email_verification_token`, `email_verification_expires_at` |
| `student_sessions` | Add: `status` (enum: pending/approved/rejected), `approved_at`, `approved_by` |
| `student_sessions` | Add: `locked_at`, `locked_by` (summative assessment lock) |
| `classes` | Add: `archived_at` (timestamp, null = active) |
| `organisations` | Add: `deleted_at` (soft-delete), `session_timeout_minutes` (configurable) |

---

## 7. Timeline

```
Day 1:   CIG admin accounts + TOTP login + recovery codes
Day 2:   Teacher TOTP enforcement + recovery code reuse + password strengthening
Day 3:   Password history + breach check + session termination on security events
Day 4:   Student approval workflow (pending/approved/rejected state machine)
Day 5:   Student PIN upgrade (6-digit) + lockout tiers + approval UX
Day 6:   Email verification + email-domain bug fix + force initial password
Day 7:   Permanent deletion cascades (school, teacher, student)
Day 8:   Class code regeneration + class archive + assessment lock
Day 9:   Inactivity timeout (client + server) + secure session expiry
Day 10:  Integration verification + edge case fixes + documentation
```

---

## 8. Effort & Cost Summary

| Item | Value |
|---|---|
| Total requirements | 27 |
| Working days | 10 |
| Developer rate | Agreed separately |
| Additional AWS monthly cost | ~£12–20/month |
| AWS services added | SES, WAF, SNS, CloudWatch alarms, Secrets Manager (expanded) |

---

## 9. Acceptance Criteria

Each requirement is considered complete when:

1. The API endpoint functions correctly with valid and invalid inputs
2. Appropriate error messages are returned for all failure cases
3. Security controls cannot be bypassed (lockout works, MFA cannot be skipped)
4. Cascading operations complete fully without orphaned records
5. Audit log captures all security-relevant events
6. No regression in existing platform functionality

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PIN migration disrupts existing students | Medium | High | Grace period accepting both 4 and 6-digit PINs during transition; force reset on next login |
| Student approval workflow frustrates pilot teachers | Medium | Medium | Implement bulk-approve and lesson-mode toggle |
| CIG admin migration breaks existing workflows | Low | Medium | Run both auth methods in parallel during transition |
| Cascade deletion misses orphaned records | Low | High | Map all foreign keys before implementation; test with realistic data |
| 10-minute timeout generates complaints | High | Low | Make configurable per organisation; default 20 min for students |

---

## 11. Assumptions

1. Existing AWS infrastructure has capacity for these changes without scaling
2. Amazon SES is already configured (or can be configured) with the project domain
3. Frontend uses the existing React/TypeScript stack
4. A staging environment is available for testing
5. No changes to AI/chat logic are required beyond access guards (archive/lock)
6. The pilot will have a limited number of schools (under 10), limiting the blast radius of any issues

---

## 12. Post-Pilot Recommendations

| Item | Priority | Notes |
|---|---|---|
| Penetration testing | High | Validate all auth hardening with a third-party firm |
| GDPR data export ("download my data") | High | Required for full data protection compliance |
| Production hardening (error handling, edge cases) | Medium | Pilot code is functional but may need refinement |
| UI/UX polish | Medium | Security flows should be user-tested with actual teachers |
| Configurable timeout dashboard | Low | Allow schools to self-manage session timeouts |
| Full audit log viewer for IT admins | Medium | Reduces support requests to CIG |

---

*End of document.*
