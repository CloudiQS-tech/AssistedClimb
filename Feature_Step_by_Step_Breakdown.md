# Assisted Climb — Feature Step-by-Step Breakdown

**Purpose:** Understand exactly what each feature involves technically, step by step.  
**Date:** 21 August 2026

---

## A. CIG Administrator

---

### A1. Add two-step authentication to the CIG administrator login

**What it does:** CIG admins currently use a shared password (secret key in a header). This replaces that with individual accounts that require both a password AND a 6-digit code from an authenticator app (like Google Authenticator) at every login.

**Steps to implement:**

```
Step 1: Create the cig_admins database table
        → Fields: id, email, name, passwordHash, totpSecret, totpEnabled, 
          failedLoginAttempts, lockedUntil, createdAt
        → This gives each CIG admin their own account

Step 2: Build a "seed" script to create the first CIG admin
        → Since there's no registration page for CIG admins, we create 
          the first one via a command-line script
        → Hash the password with bcrypt (cost 12)

Step 3: Build POST /api/cig/login endpoint
        → Accept email + password
        → Verify password against hash
        → If TOTP is enabled → return { totpRequired: true }
        → If TOTP not yet set up → return { totpSetupRequired: true }

Step 4: Build POST /api/cig/totp/setup endpoint
        → Generate a random TOTP secret (32 characters)
        → Create a QR code URL (otpauth://totp/AssistedClimb:admin@email...)
        → Return the QR code data + manual entry key to the frontend
        → Don't save the secret yet (wait for verification)

Step 5: Build POST /api/cig/totp/confirm-setup endpoint
        → Admin scans QR, enters the 6-digit code from their app
        → Verify the code matches the pending secret
        → If valid → save totpSecret to DB, set totpEnabled = true
        → If invalid → return error, ask them to try again

Step 6: Build POST /api/cig/totp/verify endpoint (used at every login)
        → Accept the 6-digit code
        → Verify against stored totpSecret using otplib
        → If valid → create session, return success
        → If invalid → increment failed attempts, return error

Step 7: Update the requireAdmin middleware
        → Instead of checking x-admin-secret header
        → Check for a valid CIG admin session (req.session.cigAdminId)

Step 8: Frontend — Login page for CIG admin
        → Email + password form
        → If totpRequired → show 6-digit code input
        → If totpSetupRequired → show QR code + verification input
```

**What changes in the user experience:**
- Before: CIG admin enters a secret key that gives instant access
- After: CIG admin has their own email/password, then must enter a code from their phone app every time they log in

---

### A2. Add authenticator recovery and replacement

**What it does:** When a CIG admin sets up their authenticator app, the system generates 10 single-use backup codes. If they lose their phone, they can use one of these codes instead of the authenticator code.

**Steps to implement:**

```
Step 1: Create the recovery_codes database table
        → Fields: id, userId, userType ('cig_admin' or 'teacher'), 
          codeHash, usedAt, createdAt
        → Each user gets 10 rows (one per code)

Step 2: Generate codes during TOTP setup (modify A1 Step 5)
        → When TOTP is confirmed, generate 10 random codes
          (format: XXXX-XXXX, 8 alphanumeric characters)
        → Hash each code with bcrypt
        → Store all 10 hashes in recovery_codes table
        → Return the plain-text codes to the frontend (shown ONCE)

Step 3: Frontend — Display recovery codes
        → Show all 10 codes in a clear format
        → Provide "Copy all" and "Download as text file" buttons
        → Show warning: "Save these codes. You won't see them again."
        → Require user to confirm they've saved them before continuing

Step 4: Build POST /api/cig/recovery/verify endpoint
        → Accept a recovery code instead of TOTP code
        → Loop through unused codes for this user
        → bcrypt.compare() each one until a match is found
        → If match → mark that code as used (set usedAt), complete login
        → If no match → return error

Step 5: Add device replacement flow
        → After using a recovery code to log in, allow admin to:
          a) Set up a new TOTP device (re-run setup flow)
          b) This invalidates the old totpSecret
          c) Generates fresh recovery codes (old ones invalidated)
```

**What changes in the user experience:**
- Before: If CIG admin lost access to shared secret, they'd need server access to recover
- After: They see 10 backup codes at setup, can use one if phone is lost, then set up a new device

---

### A3. Improve password-recovery security

**What it does:** When a CIG admin resets their password, they still need to prove their identity with their authenticator code (or recovery code). The system also limits how many times someone can guess recovery codes, and notifies the CIG team when recovery is used.

**Steps to implement:**

```
Step 1: Modify the password reset flow
        → After clicking the reset link in their email and setting a new password
        → Before the reset is accepted, require TOTP verification
        → Show: "Enter your authenticator code to confirm this password reset"
        → Allow recovery code as alternative

Step 2: Add attempt tracking for recovery codes
        → Add failedRecoveryAttempts column to cig_admins table
        → On each failed recovery code attempt → increment counter
        → After 3 failed attempts → lock recovery for 30 minutes
        → Return: "Too many incorrect attempts. Please try again later."

Step 3: Send notification when recovery is used
        → When a recovery code is successfully used (login OR password reset)
        → Send email/SNS notification to CIG team
        → Include: who used it, when, from which IP address
        → Purpose: alert the team in case the recovery was unauthorised

Step 4: Audit log the recovery event
        → Log: action = "cig_admin.recovery_code_used"
        → Include: adminId, IP, timestamp, which code index was consumed
```

**What changes in the user experience:**
- Before: Password reset only requires the email link — no second factor
- After: Even to reset a password, you need your phone (or a backup code). CIG team gets alerted if backup codes are used.

---

### A4. Recovery-code rotation

**What it does:** Allows a CIG admin to generate a brand new set of 10 recovery codes at any time, invalidating all previous codes.

**Steps to implement:**

```
Step 1: Build POST /api/cig/recovery-codes/rotate endpoint
        → Require authenticated CIG admin session
        → Require current TOTP code (prove you still have your device)
        → Delete all existing recovery codes for this user
        → Generate 10 new codes (same process as A2 Step 2)
        → Hash and store them
        → Return the new plain-text codes to the frontend

Step 2: Frontend — "Regenerate recovery codes" button
        → In CIG admin security settings
        → Ask for TOTP code first (confirm identity)
        → Display the new 10 codes
        → Same "save these" warning as initial setup

Step 3: Audit log the rotation
        → Log: action = "cig_admin.recovery_codes_rotated"
```

**What changes in the user experience:**
- Before: No recovery codes existed
- After: Admin can get fresh codes whenever they want (e.g., if they suspect old ones were compromised)

---

### A5. Add permanent school deletion

**What it does:** CIG admin can permanently delete a school and ALL associated data — not just suspend it.

**Steps to implement:**

```
Step 1: Build GET /api/cig/organisations/:id/deletion-preview endpoint
        → Query and return a count of everything that will be deleted:
          - Number of teachers
          - Number of classes
          - Number of students
          - Number of stage entries (student work)
          - Number of chat messages (AI interactions)
          - Number of audit log entries
        → This is shown to the admin BEFORE they confirm

Step 2: Build DELETE /api/cig/organisations/:id endpoint
        → Require authenticated CIG admin
        → Require confirmation parameter (e.g., pass the org name as confirmation)
        → Delete in order (respecting foreign key constraints):
          1. Chat messages (linked to student sessions)
          2. Stage entries (linked to student sessions)
          3. Student sessions (linked to classes)
          4. Classes (linked to teachers)
          5. Teachers (linked to organisation)
          6. Organisation itself
        → Use a database transaction (all or nothing)
        → Log the deletion in audit log BEFORE deleting the org

Step 3: Frontend — Deletion confirmation dialog
        → Show the preview counts: "This will permanently delete: 
          5 teachers, 12 classes, 156 students, 2,400 pieces of work..."
        → Require typing the school name to confirm
        → Show: "This action CANNOT be undone"
        → Red button: "Permanently Delete School"
```

**What changes in the user experience:**
- Before: CIG could only suspend a school (set active = false), data remained in the database
- After: CIG can permanently remove a school and every trace of its data

---

## B. School IT Administrator

---

### B1. Force replacement of the initial password

**What it does:** When CIG creates a school, the IT admin gets a temporary password. They MUST change it before they can do anything else.

**Steps to implement:**

```
Step 1: Verify mustChangePassword is set on IT admin creation
        → Check POST /api/admin/organisations endpoint
        → When creating the IT admin user, ensure mustChangePassword: true
        → Check POST /api/admin/organisations/:id/it-admin endpoint
        → Same — set mustChangePassword: true
        → (Currently the org creation route does NOT set this — bug)

Step 2: Add middleware enforcement
        → In the teacher auth middleware (requireTeacher)
        → After verifying the session is valid:
          If teacher.mustChangePassword === true AND
          the request path is NOT /api/auth/change-password AND
          the request path is NOT /api/auth/logout
          → Return 403 with { mustChangePassword: true, 
              error: "You must change your password before continuing" }

Step 3: Frontend — Force redirect to change-password page
        → On any 403 response with mustChangePassword: true
        → Redirect to the change-password form
        → Don't allow navigation elsewhere until password is changed
```

**What changes in the user experience:**
- Before: IT admin could potentially use the temporary password indefinitely
- After: First thing they see after logging in is "You must set a new password" — can't skip it

---

### B2. Fix the school email-domain restriction

**What it does:** When a school is set up, the IT admin specifies which email domain(s) teachers must use (e.g., `@school.edu.uk`). Currently this isn't saving correctly, so teachers from any domain can register.

**Steps to implement:**

```
Step 1: Investigate the bug
        → Check how allowedEmailDomains is stored in the organisations table
        → Check the endpoint that UPDATES the domain restriction
        → Likely issue: the field is a text array (text[]) in PostgreSQL, 
          and the update endpoint may not be saving it correctly
          (e.g., sending a string instead of an array, or not stripping the @ symbol)

Step 2: Fix the save/update endpoint
        → Ensure the PUT /api/admin/organisations/:id endpoint correctly
          saves the allowedEmailDomains array
        → Normalise input: strip @, lowercase, trim whitespace
        → Example: ["@School.edu.uk", " myschool.ac.uk"] 
          → stored as ["school.edu.uk", "myschool.ac.uk"]

Step 3: Verify the registration check
        → In POST /api/auth/register, the domain check already exists:
          it extracts the email domain and compares against the allowed list
        → Verify this works with the fixed data
        → Test: register with valid domain → success
        → Test: register with invalid domain → blocked with clear error message

Step 4: Frontend — Show current restriction clearly
        → In school settings, display the currently saved domain(s)
        → Allow IT admin to edit/add/remove domains
        → Show confirmation when saved
```

**What changes in the user experience:**
- Before: The restriction was unreliable — sometimes teachers from wrong domains could register
- After: Only teachers with the correct school email can register. Clear error message if they try with a personal email.

---

### B3. Add teacher email verification

**What it does:** After a teacher registers, they receive a verification email. They must click the link in the email before their account becomes active.

**Steps to implement:**

```
Step 1: Add columns to teachers table
        → emailVerified: boolean, default false
        → emailVerificationToken: text (nullable)
        → emailVerificationExpiresAt: timestamp (nullable)

Step 2: Modify POST /api/auth/register
        → After creating the teacher account:
        → Generate a random verification token (UUID)
        → Set emailVerified = false
        → Set emailVerificationToken = token
        → Set emailVerificationExpiresAt = now + 24 hours
        → Send verification email via SES with link:
          https://app.assistedclimb.education/verify-email?token=xxxxx

Step 3: Build POST /api/auth/verify-email endpoint
        → Accept the token from the URL
        → Find the teacher with that token
        → Check token hasn't expired
        → Set emailVerified = true, clear the token
        → Return success

Step 4: Build POST /api/auth/resend-verification endpoint
        → Require authenticated teacher session
        → Generate new token + new expiry
        → Send the email again
        → Rate limit: max 3 resends per hour

Step 5: Add verification middleware
        → In requireTeacher middleware:
          If teacher.emailVerified === false AND
          the request is NOT verify-email, resend-verification, or logout
          → Return 403 with { emailVerificationRequired: true }

Step 6: Frontend — Verification screens
        → After registration: "Check your email" screen with resend button
        → On clicking link: "Email verified!" success screen
        → If trying to access platform unverified: redirect to "check your email" screen
```

**What changes in the user experience:**
- Before: Teacher registers → immediately has full access
- After: Teacher registers → sees "check your email" → clicks link → then gets access

---

### B4. Add permanent teacher-account deletion

**What it does:** School IT admin can permanently delete a teacher's account and all their data, after seeing a warning about what will be removed.

**Steps to implement:**

```
Step 1: Build GET /api/it-admin/teachers/:id/deletion-preview endpoint
        → Require IT admin auth (teacher with isItAdmin = true, same org)
        → Return counts of what will be deleted:
          - Teacher account details
          - Number of classes owned by this teacher
          - Number of students across those classes
          - Number of student work entries (stage entries)
          - Number of AI chat messages
          - Number of feedback entries

Step 2: Build DELETE /api/it-admin/teachers/:id endpoint
        → Require IT admin auth + same organisation
        → Cannot delete yourself
        → Delete in order:
          1. Chat messages (via student sessions in teacher's classes)
          2. Stage entries (via student sessions in teacher's classes)
          3. Student sessions (in teacher's classes)
          4. Classes (owned by teacher)
          5. Teacher record itself
        → Use database transaction
        → Audit log before deletion

Step 3: Frontend — Deletion flow
        → IT admin selects teacher → clicks "Delete account"
        → Dialog shows: "Deleting [Teacher Name] will permanently remove:
          3 classes, 45 students, 890 pieces of work, 2,300 AI messages"
        → Require typing teacher's name or email to confirm
        → "This cannot be undone"
```

**What changes in the user experience:**
- Before: No way to remove a teacher — they exist forever
- After: IT admin can permanently remove a teacher and everything they created

---

## C. Teacher Login Security

---

### C1. Force teacher two-step authentication enrolment

**What it does:** Teachers cannot use the platform until they've set up an authenticator app. It's mandatory, not optional.

**Steps to implement:**

```
Step 1: Build POST /api/auth/totp/setup endpoint (if not already complete)
        → Generate TOTP secret
        → Return QR code data (otpauth:// URL encoded as QR)
        → Return manual entry key (for typing into authenticator app)
        → Store secret temporarily in session (not DB yet)

Step 2: Build POST /api/auth/totp/confirm-setup endpoint
        → Teacher enters the 6-digit code from their app
        → Verify it matches the pending secret
        → If valid → save totpSecret to teacher record, set totpEnabled = true
        → Generate recovery codes (reuse system from A2)
        → Return recovery codes to display

Step 3: Add TOTP enforcement to requireTeacher middleware
        → After verifying session:
          If teacher.totpEnabled === false AND
          request path is NOT /api/auth/totp/setup AND
          request path is NOT /api/auth/totp/confirm-setup AND
          request path is NOT /api/auth/logout
          → Return 403 with { totpSetupRequired: true }

Step 4: Frontend — TOTP setup wizard
        → Step 1: "Download an authenticator app" (links to Google Authenticator, Authy)
        → Step 2: Show QR code + manual key
        → Step 3: "Enter the 6-digit code from your app to verify"
        → Step 4: Show recovery codes with save warning
        → Step 5: "Setup complete!" → redirected to platform
```

**What changes in the user experience:**
- Before: TOTP was available but teachers could ignore it
- After: First time a teacher logs in, they MUST set up their authenticator app before accessing anything

---

### C2. Add teacher authenticator recovery

**What it does:** Teachers get backup codes (same as CIG admins). If they lose their phone, they can use a code. There's also a process for revoking a lost device and setting up a new one.

**Steps to implement:**

```
Step 1: Recovery codes are generated during TOTP setup (C1 Step 2)
        → 10 codes, hashed with bcrypt, stored in recovery_codes table
        → userType = 'teacher', userId = teacher.id

Step 2: Modify POST /api/auth/totp/verify to accept recovery codes
        → If the normal 6-digit code fails:
        → Check if input matches recovery code format (XXXX-XXXX)
        → If so, try to match against unused recovery codes
        → If match → consume it (set usedAt), complete login

Step 3: Build POST /api/auth/totp/revoke endpoint
        → Require authenticated teacher (via recovery code login)
        → Clear totpSecret and set totpEnabled = false
        → Delete all existing recovery codes
        → Teacher will be forced to set up TOTP again (C1 Step 3 kicks in)

Step 4: IT admin override (safety valve)
        → Build POST /api/it-admin/teachers/:id/reset-mfa endpoint
        → IT admin can clear a teacher's TOTP (if they lost phone AND codes)
        → Set totpSecret = null, totpEnabled = false
        → Teacher must re-enrol at next login

Step 5: Frontend — Recovery flow
        → On login TOTP screen: "Lost your device?" link
        → Shows recovery code input
        → After successful recovery: prompt to set up new device immediately
```

**What changes in the user experience:**
- Before: If a teacher lost their phone, they were locked out with no recovery path
- After: They can use a backup code, then set up a new device. IT admin can also help if they've lost everything.

---

### C3. Strengthen teacher passwords

**What it does:** Passwords must be at least 12 characters, can't be common/breached passwords, and can't reuse the last 5 passwords.

**Steps to implement:**

```
Step 1: Create password_history table
        → Fields: id, teacherId, passwordHash, createdAt
        → Stores the last 5 hashes for each teacher

Step 2: Update password validation (Zod schema)
        → Change min(8) to min(12) everywhere passwords are validated:
          - Registration
          - Change password
          - Reset password
          - Admin reset password

Step 3: Add HaveIBeenPwned check
        → When a new password is submitted:
        → Hash it with SHA-1
        → Send first 5 characters to the HIBP API (k-anonymity — safe)
        → API returns all matching hashes
        → Check if the full hash appears in the response
        → If found → reject: "This password has appeared in a data breach. 
          Please choose a different password."
        → If API is unreachable → allow the password (don't block users)

Step 4: Add password history check
        → When changing/resetting password:
        → Load last 5 entries from password_history for this teacher
        → bcrypt.compare() new password against each
        → If any match → reject: "You cannot reuse your last 5 passwords"

Step 5: Save to password history on every password change
        → After successfully changing password:
        → Insert old passwordHash into password_history
        → If more than 5 entries exist → delete the oldest

Step 6: Add common password block (local check)
        → Maintain a list of top 1000 common passwords
        → Check new password against this list
        → If match → reject: "This password is too common. Please choose something more unique."
```

**What changes in the user experience:**
- Before: Any 8-character password was accepted
- After: Password must be 12+ chars, can't be breached/common, can't be one of your last 5

---

### C4. Improve teacher password resets

**What it does:** When an admin resets a teacher's password, the teacher is forced to create a new one immediately at next login.

**Steps to implement:**

```
Step 1: Verify all admin reset paths set mustChangePassword
        → POST /api/admin/teachers/:teacherId/reset-password → already sets it ✓
        → POST /api/auth/admin-reset-password → already sets it ✓
        → IT admin reset (if we add one) → must set it
        → Any future admin password action → must set it

Step 2: Verify the enforcement middleware works
        → requireTeacher middleware should already check mustChangePassword
        → If true → block all requests except change-password and logout
        → Test: login with mustChangePassword = true → get blocked → change password → unblocked

Step 3: Frontend verification
        → After login, if response includes mustChangePassword: true
        → Redirect immediately to change-password page
        → Don't allow navigation away
```

**What changes in the user experience:**
- Before: In some edge cases, a teacher could keep using an admin-set temporary password
- After: Guaranteed that any admin-reset password MUST be changed immediately

---

## D. Student Login Security

---

### D1. Require teacher approval of new student accounts

**What it does:** When a student enters a class code and their name for the first time, they don't get immediate access. Instead, they go into a "pending" state until the teacher approves them.

**Steps to implement:**

```
Step 1: Add status column to student_sessions table
        → status: enum ('pending', 'approved', 'rejected')
        → Default: 'pending' for new students
        → Add approved_at: timestamp (nullable)
        → Add approved_by: integer (teacher id, nullable)

Step 2: Modify POST /api/student/join (new student path)
        → When a brand-new student joins (no existing record):
        → Create the student_sessions record with status = 'pending'
        → Hash and store their PIN (same as before)
        → But DON'T set the session cookie / DON'T grant access
        → Return: { status: 'pending', message: 'Your account is awaiting teacher approval' }

Step 3: Modify POST /api/student/join (returning student path)
        → When an existing student enters correct PIN:
        → Check their status
        → If 'pending' → don't grant access, return pending message
        → If 'approved' → grant access as normal
        → If 'rejected' → return error (account shouldn't exist, but just in case)

Step 4: Build POST /api/teacher/classes/:classId/students/:sessionId/approve
        → Require teacher auth + owns this class
        → Set status = 'approved', approved_at = now, approved_by = teacher.id
        → Return success

Step 5: Build POST /api/teacher/classes/:classId/students/:sessionId/reject
        → Require teacher auth + owns this class
        → Delete the student session record entirely (D3 requirement)
        → Return success

Step 6: Build POST /api/teacher/classes/:classId/students/approve-all
        → Bulk approve all pending students in a class
        → Update all records where status = 'pending' in this class

Step 7: Build GET /api/teacher/classes/:classId/pending-students
        → Return list of students awaiting approval
        → Include: name, PIN creation time, status

Step 8: Modify requireStudentSession middleware
        → After finding the student session:
        → If status !== 'approved' → return 403
        → Only approved students can access any student endpoint

Step 9: Frontend — Teacher approval queue
        → Show badge/count of pending students on class view
        → List pending students with Approve/Reject buttons
        → "Approve All" button for convenience

Step 10: Frontend — Student pending screen
         → After joining: "Your teacher needs to approve your account. 
           Please wait or ask your teacher."
         → If student tries to log in while pending: same message
```

**What changes in the user experience:**
- Before: Student enters class code + name + PIN → immediately in
- After: Student enters details → sees "waiting for approval" → teacher approves → then they can work

---

### D2. Display registration-status messages

**What it does:** Students see clear messages about their account status at every stage.

**Steps to implement:**

```
Step 1: When student joins for first time (status = pending)
        → Return: { status: 'pending', 
          message: 'Your account is awaiting teacher approval. Please wait.' }

Step 2: When pending student tries to log in again
        → After PIN verification succeeds BUT status is still 'pending'
        → Return: { status: 'pending',
          message: 'Your account is still awaiting teacher approval. 
          Please speak to your teacher.' }

Step 3: Frontend — Status display
        → Show the message prominently
        → No links to platform content
        → Maybe: "Ask your teacher to approve your account"
```

**What changes in the user experience:**
- Before: N/A (no pending state existed)
- After: Student always knows exactly what's happening with their account

---

### D3. Delete rejected registrations

**What it does:** When a teacher rejects a student, the pending account is automatically permanently deleted.

**Steps to implement:**

```
Step 1: In the reject endpoint (D1 Step 5)
        → Instead of setting status = 'rejected'
        → Hard-delete the student_sessions record entirely
        → Since it's a pending student, there's no work to cascade
          (they never had access, so no stage entries or chat messages)
        → DELETE FROM student_sessions WHERE id = :id

Step 2: Audit log the rejection
        → Log: action = "student.registration_rejected"
        → Include: student name, class, rejecting teacher
```

**What changes in the user experience:**
- Before: N/A
- After: Rejected students disappear completely — no trace left in the system

---

### D4. Increase student PINs to six digits

**What it does:** Student PINs change from 4 digits to 6 digits for stronger security.

**Steps to implement:**

```
Step 1: Update PIN validation schemas
        → Change regex from ^\d{4}$ to ^\d{6}$
        → In: student join body, change-pin body
        → Error message: "PIN must be exactly 6 digits"

Step 2: Handle existing students (migration)
        → Existing students have 4-digit PINs stored as bcrypt hashes
        → Option A: Null their pinHash → forces them to set new 6-digit PIN on next login
        → Option B: Accept both 4 and 6 digits during transition period
        → Recommended: Option A (cleaner, more secure)

Step 3: Run migration script
        → UPDATE student_sessions SET pin_hash = NULL 
          WHERE pin_hash IS NOT NULL
        → This triggers the "teacher reset PIN" flow — student sets new PIN at next login

Step 4: Update frontend PIN input
        → Change input maxLength from 4 to 6
        → Update placeholder text: "Enter your 6-digit PIN"
        → Update any helper text about PINs

Step 5: Ensure PINs are never displayed
        → Verify: no endpoint returns pinHash
        → Verify: no frontend displays the PIN after entry
        → PIN only exists momentarily during input, then is hashed immediately
```

**What changes in the user experience:**
- Before: Student sets and enters a 4-digit PIN
- After: Student must set a 6-digit PIN (all existing students will be prompted to set a new one)

---

### D5. Add incorrect-PIN controls (two-tier)

**What it does:** Instead of one lockout level, there are now two: a short cooldown after 3 wrong attempts, and a full lock after 5.

**Steps to implement:**

```
Step 1: Modify the PIN verification logic in POST /api/student/join
        → Current: lock after 5 attempts for 15 minutes
        → New: 
          - After 3 failed attempts → set pinLockedUntil = now + 5 minutes
            Return: "Too many incorrect attempts. Please wait 5 minutes."
          - After 5 failed attempts → set pinLockedUntil = null, 
            set permanentlyLocked = true (new field)
            Return: "Your account has been locked. Please ask your teacher to unlock it."

Step 2: Add permanentlyLocked field (or reuse existing isBlocked)
        → Option: use a new boolean field `pinPermanentlyLocked`
        → Or: repurpose the lockout by setting pinLockedUntil to a far-future date
        → Recommended: use a large pinLockedUntil value (year 9999) to indicate permanent lock
          This avoids a new column and the teacher unlock already clears pinLockedUntil

Step 3: Update the unlock endpoint behaviour
        → POST /api/teacher/classes/:classId/students/:sessionId/unlock-pin
        → Must clear pinLockedUntil (handles both tier 1 and tier 2)
        → Reset failedPinAttempts to 0

Step 4: Update error messages based on tier
        → Attempts 1-2: "Incorrect PIN. X attempts remaining."
        → Attempt 3: "Too many incorrect attempts. Please wait 5 minutes and try again."
        → Attempts 4: After cooldown expires, "Incorrect PIN. 1 attempt remaining before lockout."
        → Attempt 5: "Your account has been locked. Please speak to your teacher."
```

**What changes in the user experience:**
- Before: Lock after 5 wrong attempts, auto-unlock after 15 minutes
- After: Soft pause (5 min) at 3 attempts, hard lock at 5 (only teacher can unlock)

---

### D6. Keep unlocking and PIN resetting separate

**What it does:** Teachers have two distinct actions: unlock (remove the lock, student uses same PIN) and reset (clear the PIN, student must choose a new one).

**Steps to implement:**

```
Step 1: Verify existing implementation
        → POST /api/teacher/classes/:classId/students/:sessionId/unlock-pin
          → Clears pinLockedUntil and failedPinAttempts
          → Does NOT touch pinHash
          → Student can log in with their existing PIN

        → POST /api/teacher/classes/:classId/students/:sessionId/reset-pin
          → Sets pinHash = null
          → Clears pinLockedUntil and failedPinAttempts
          → Student must choose a new PIN at next login

Step 2: Already implemented ✓
        → These are already separate endpoints in the codebase
        → Just need to verify they work with the new two-tier lockout
        → Test: locked student → teacher unlocks → student uses same PIN → works
        → Test: teacher resets → student must set new 6-digit PIN → works
```

**What changes in the user experience:**
- No change — this already works correctly.

---

## E. Classes and Climbs

---

### E1. Allow teachers to change the class code

**What it does:** A teacher can generate a new class code. Existing students stay in the class, but the old code stops working for new registrations.

**Steps to implement:**

```
Step 1: Build POST /api/teacher/classes/:classId/regenerate-code endpoint
        → Require teacher auth + owns this class
        → Generate a new 6-character alphanumeric code (same logic as class creation)
        → Ensure uniqueness (check no other class has this code)
        → Update the class record with the new code
        → Return the new code

Step 2: Existing students are unaffected
        → Students are linked to classes via classId (foreign key)
        → The class code is only used for JOINING, not for ongoing access
        → So changing the code doesn't affect existing students at all
        → No migration or student notification needed

Step 3: Old code stops working immediately
        → Since the code column is updated, any student trying to join 
          with the old code will get "Class not found"
        → No need for an "old codes" table — it's just gone

Step 4: Frontend — "Regenerate code" button
        → In class settings: button to generate new code
        → Confirm dialog: "Are you sure? The current code will stop working immediately."
        → Show new code prominently after generation
        → "Share this new code with students who need to join"

Step 5: Audit log
        → Log: action = "class.code_regenerated"
        → Include: classId, old code, new code, teacher
```

**What changes in the user experience:**
- Before: Class code is permanent — if it's leaked, anyone with it can keep joining
- After: Teacher can change the code at any time. Existing students unaffected. New students need the new code.

---

### E2. Add a class-archive function

**What it does:** A teacher can archive a class, making it completely read-only. No new students, no new work, no AI interactions. Everyone can still view what's there.

**Steps to implement:**

```
Step 1: Add archivedAt column to classes table
        → archivedAt: timestamp, nullable
        → If null → class is active
        → If set → class is archived (and we know when)

Step 2: Build POST /api/teacher/classes/:classId/archive endpoint
        → Set archivedAt = now
        → Return success

Step 3: Build POST /api/teacher/classes/:classId/unarchive endpoint
        → Set archivedAt = null
        → Return success (in case teacher archives by mistake)

Step 4: Add archive guard middleware
        → Create a function: isClassArchived(classId)
        → Returns true if archivedAt is not null

Step 5: Block student joins for archived classes
        → In POST /api/student/join:
        → After finding the class, check if archivedAt is set
        → If archived → return 403: "This class is no longer accepting students"

Step 6: Block student writes for archived classes
        → In PUT /api/student/stages/:stage (save work):
        → Check if the student's class is archived
        → If archived → return 403: "This class has been archived. You cannot make changes."

Step 7: Block student deletes for archived classes
        → In DELETE /api/student/stages/:stage:
        → Same archive check → block

Step 8: Block AI chat for archived classes
        → In POST /api/student/chat:
        → Check if student's class is archived
        → If archived → return 403: "AI support is not available for archived classes."

Step 9: Block new student approvals for archived classes
        → In the approve endpoint: check archive status first

Step 10: Frontend — Archive controls
         → "Archive class" button in class settings
         → Archived classes shown with visual indicator (greyed out, badge)
         → Students see "This class is archived (read-only)" banner
         → All edit/submit buttons disabled in archived classes
```

**What changes in the user experience:**
- Before: A class is always "live" — students can always add work
- After: Teacher can freeze a class. Everyone can still view content, but nothing new can be added.

---

### E3. Add a summative-assessment lock

**What it does:** After a teacher has assessed a student's Climb, they can lock it. The student can see their work but can't change, delete, or continue chatting with AI.

**Steps to implement:**

```
Step 1: Add lock fields to student_sessions table
        → lockedAt: timestamp, nullable
        → lockedBy: integer (teacher id), nullable

Step 2: Build POST /api/teacher/classes/:classId/students/:sessionId/lock endpoint
        → Set lockedAt = now, lockedBy = teacher.id
        → Return success

Step 3: Build POST /api/teacher/classes/:classId/students/:sessionId/unlock endpoint
        → Set lockedAt = null, lockedBy = null
        → Return success (for corrections)

Step 4: Add lock check to student write endpoints
        → In PUT /api/student/stages/:stage:
          If student's lockedAt is set → return 403:
          "Your work has been locked for assessment. You can view but not edit."
        → In DELETE /api/student/stages/:stage: same check
        → In POST /api/student/chat: same check
        → In POST /api/student/change-pin: this should still work (not affected)

Step 5: Frontend — Lock indicator
        → Teacher: "Lock Climb" button per student (with unlock option)
        → Student: "Your climb has been locked by your teacher" banner
        → All edit buttons disabled, AI chat input disabled
        → Content is fully visible / readable
```

**What changes in the user experience:**
- Before: Students can always edit/delete their work, even after assessment
- After: Teacher locks the climb → student can view everything but can't touch it

---

## F. Sessions

---

### F1. Add automatic logout for every user type

**What it does:** If anyone (admin, teacher, or student) is inactive for 10 minutes, they get a warning. If they don't respond within 2 more minutes, their work is saved and they're logged out.

**Steps to implement:**

```
Step 1: Client-side inactivity detection (frontend)
        → Track user activity events: mouse move, key press, click, scroll, touch
        → Start a timer after last activity
        → At 10 minutes: show warning modal
        → At 12 minutes: trigger auto-save + logout

Step 2: Warning modal component
        → "You will be logged out due to inactivity"
        → Countdown timer showing seconds remaining
        → "Stay logged in" button (resets the timer)
        → If no interaction → proceeds to logout

Step 3: Auto-save before logout
        → For students: if there's unsaved work in any stage form, 
          call PUT /api/student/stages/:stage to save it
        → For teachers: if there's an unsaved form (e.g., task editing),
          save the draft
        → For CIG admins: nothing to save (admin actions are immediate)

Step 4: Logout action
        → Call POST /api/auth/logout (for teachers)
        → Call POST /api/student/logout (for students)
        → Clear local session state
        → Redirect to login page
        → Show: "You were logged out due to inactivity"

Step 5: Server-side session TTL (backup enforcement)
        → Reduce session maxAge from 8 hours to 15 minutes
        → With rolling: true, every request resets the 15-min timer
        → So if the client-side timer fails, the server still expires the session

Step 6: Apply to all user types
        → Same inactivity timer component used across:
          - CIG admin dashboard
          - Teacher dashboard
          - Student workspace
        → Timeout value could be configurable per org (recommendation)
```

**What changes in the user experience:**
- Before: Sessions last 8 hours — you could leave a computer logged in all day
- After: 10 minutes idle → warning popup → 2 more minutes → auto-saved and logged out

---

### F2. Ensure browser sessions expire securely

**What it does:** If someone closes the browser and reopens it, they shouldn't still be logged in indefinitely. The inactivity limit must still apply.

**Steps to implement:**

```
Step 1: Change session cookie type
        → Current: maxAge: 8 * 60 * 60 * 1000 (persistent cookie, survives browser close)
        → New: remove maxAge from cookie config
        → This makes it a "session cookie" — deleted when browser closes
        → But: some browsers restore session cookies... so we also need server-side enforcement

Step 2: Add lastActivityAt tracking
        → In the session middleware (or as a separate middleware):
        → On every request: update req.session.lastActivityAt = Date.now()
        → This records when the user was last active

Step 3: Add server-side inactivity check
        → In requireTeacher and requireStudentSession middleware:
        → Check: if Date.now() - req.session.lastActivityAt > 12 * 60 * 1000 (12 min)
        → If expired → destroy the session, return 401
        → This ensures even if the cookie survives, the session is dead

Step 4: Reduce PostgreSQL session store TTL
        → Session store config: set pruneSessionInterval (auto-delete expired sessions)
        → Old sessions get cleaned up from the DB

Step 5: Test scenarios
        → Close browser → reopen → try to access platform → should be logged out
        → Leave tab open 15 min → try to do something → should get 401
        → Active use for hours → should stay logged in (rolling resets the timer)
```

**What changes in the user experience:**
- Before: Close laptop, open it next morning → might still be logged in
- After: Close browser → logged out. Leave it idle → logged out after 12 minutes.

---

## G. Permanent Deletion

---

### G1. Permanently delete student, teacher and school information

**What it does:** When deleting a student, ALL their data is removed — not just the account, but every piece of work, every AI conversation, every bit of feedback.

**Steps to implement:**

```
Step 1: Map all student-related data
        → student_sessions (the account itself)
        → stage_entries (MAP, TORCH, RESEARCH, COMPASS, EMBED work)
        → chat_messages (AI conversations in TORCH stage)
        → Any feedback entries linked to this student
        → Any assessment records
        → The PIN hash, session nonce, timestamps

Step 2: Build DELETE /api/teacher/classes/:classId/students/:sessionId endpoint
        → Require teacher auth + owns this class
        → Show warning first (via a GET preview endpoint)
        → Delete in order (FK constraints):
          1. DELETE FROM chat_messages WHERE session_id = :id
          2. DELETE FROM stage_entries WHERE session_id = :id
          3. DELETE FROM student_sessions WHERE id = :id
        → Use database transaction

Step 3: Build GET /api/teacher/classes/:classId/students/:sessionId/deletion-preview
        → Return counts:
          { name: "Alice", chatMessages: 45, stageEntries: 5, 
            createdAt: "2026-03-15" }

Step 4: For teacher deletion (B4) — same but bigger cascade
        → Delete all students in all teacher's classes
        → Delete all classes
        → Delete teacher record

Step 5: For school deletion (A5) — biggest cascade
        → Delete all teachers (which cascades to students)
        → Delete organisation record

Step 6: Audit trail
        → BEFORE deleting, log what was deleted:
          action = "student.permanently_deleted"
          metadata = { studentName, classId, stageEntriesCount, chatMessagesCount }
        → This creates a record that deletion happened (without storing the actual data)

Step 7: Frontend — Deletion confirmation
        → Teacher clicks "Delete student"
        → Dialog: "Permanently delete [Student Name]? This will remove:
          - Their account and PIN
          - 5 pieces of work (MAP, TORCH, RESEARCH, COMPASS, EMBED)
          - 45 AI chat messages
          - All feedback and assessment records
          This action CANNOT be undone."
        → Require confirmation click
```

**What changes in the user experience:**
- Before: Students could be "blocked" (hidden) but their data remained in the database
- After: True permanent deletion — all traces removed, with an audit log noting that deletion occurred

---

## Other

---

### O1. Terminate sessions following security changes

**What it does:** When a teacher changes their password, recovers their account, or replaces their authenticator, ALL their existing login sessions on other devices are immediately killed.

**Steps to implement:**

```
Step 1: Identify all trigger points
        → POST /api/auth/change-password (password changed)
        → POST /api/auth/reset-password (password reset via token)
        → POST /api/auth/totp/revoke (authenticator removed)
        → POST /api/auth/totp/confirm-setup (new authenticator set up)
        → POST /api/cig/recovery/verify (recovery code used)
        → IT admin MFA reset

Step 2: Build a session-purge utility function
        → async function terminateAllSessions(teacherId: number)
        → Query the PostgreSQL session store table:
          DELETE FROM "session" WHERE sess::jsonb->>'teacherId' = :teacherId::text
        → This kills every session for that teacher across all devices/browsers
        → Also clear the loginToken in the teachers table:
          UPDATE teachers SET login_token = NULL WHERE id = :teacherId

Step 3: Call the purge function at each trigger point
        → After the security action succeeds, call terminateAllSessions()
        → The CURRENT session (the one making the change) should be preserved
          OR the user should be required to log in again with new credentials

Step 4: Handle the current session
        → Option A: Keep current session alive (user just changed password, 
          they're clearly the legitimate user)
        → Option B: Kill ALL sessions including current, force re-login
        → Recommended: Option A for password change, Option B for 
          authenticator replacement (higher security)

Step 5: Audit log
        → Log: action = "teacher.sessions_terminated"
        → Include: reason (password_change, mfa_recovery, etc.), 
          number of sessions killed

Step 6: What the user on other devices sees
        → Their next API request returns 401 (session not found)
        → Frontend detects 401 → redirects to login page
        → Could show: "You were logged out because your security settings changed"
```

**What changes in the user experience:**
- Before: Changing password on one device didn't affect sessions on other devices (someone with a stolen session could continue)
- After: Security change on one device → every other device is immediately logged out

---

## Summary: Complexity by Feature

| Feature | Complexity | Main reason |
|---|---|---|
| A1 — CIG admin TOTP | Medium | New user type, new table, new login flow |
| A2 — Recovery codes | Medium | New table, hash/compare logic, one-time display |
| A3 — Recovery security | Low-Medium | Adds checks to existing flows |
| A4 — Code rotation | Low | Simple regenerate + invalidate |
| A5 — School deletion | Medium | Cascade across 6 tables in correct order |
| B1 — Force password change | Low | Field exists, just enforce consistently |
| B2 — Email domain fix | Low | Bug investigation and fix |
| B3 — Email verification | Medium | New column, token, email, middleware gate |
| B4 — Teacher deletion | Medium | Cascade delete, preview, confirmation |
| C1 — Force TOTP enrolment | Medium | Middleware gate + setup wizard |
| C2 — Teacher recovery | Low-Medium | Reuses A2 system |
| C3 — Strengthen passwords | Medium | History table + external API + validation |
| C4 — Password reset improvement | Low | Ensure flag is set |
| D1 — Student approval | High | Changes core join flow, new state machine |
| D2 — Status messages | Low | Return messages based on status |
| D3 — Delete rejected | Low | Hard delete on rejection |
| D4 — 6-digit PINs | Low | Validation change + migration |
| D5 — PIN lockout tiers | Low-Medium | Modify existing lockout logic |
| D6 — Separate unlock/reset | None | Already done |
| E1 — Change class code | Low | New endpoint, simple update |
| E2 — Class archive | Medium | Guards on 5+ endpoints |
| E3 — Assessment lock | Medium | Guards on 3+ endpoints, per-student |
| F1 — Auto logout | Medium-High | Client-side timer + save + coordination |
| F2 — Session expiry | Low-Medium | Cookie/session config changes |
| G1 — Permanent deletion | Medium | Cascade mapping, transaction, audit |
| O1 — Session termination | Medium | Session store query, multiple trigger points |

---

*End of document.*
