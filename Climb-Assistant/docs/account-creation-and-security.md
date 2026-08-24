# The Assisted Climb — Account Creation & Security

*For school leaders, IT staff, and data protection officers*

---

## How a school gets started

**1. We create your school's account**

When your school signs up to use The Assisted Climb, we create your school's account on our system. We set up a name for your school and create one login credential — this goes to your school's designated IT contact. That's the only thing we do on your behalf. We never touch your school's AI system.

**2. Your IT person takes over from day one**

Your IT contact logs in for the first time and does two things:

- They connect the platform to your school's own AI service (Google Gemini or Microsoft Azure OpenAI — whichever your school already has a contract with). They enter your school's API key. Once saved, that key is encrypted and stored inside your school's account. We never see it, and it never leaves your school's data environment.
- They get a **teacher invite code** — a short private code they share only with staff who should have access.

**3. Teachers register themselves**

Teachers go to the platform and sign up using the invite code. The IT person can restrict registration so that only email addresses ending in your school's domain (e.g. `@yourschool.sch.uk`) are accepted — so no outsider can register even if the invite code is leaked.

**4. Teachers create classes**

Each teacher creates their classes on the platform. The system automatically generates a unique **6-character join code** for each class (e.g. `KEH6K6`). The teacher shares this code with their students.

**5. Students join — no account required**

Students go to the join page, type their name and the class code. That's all. No email address, no password, no account to remember or manage. They're in.

---

## Security at every level

### The platform

The Assisted Climb runs on **Amazon AWS** infrastructure. All data is transmitted over encrypted HTTPS connections. No data is stored on individual devices.

### Your school's AI key

- Your school's AI key (Gemini or Azure) is entered by your IT person and **encrypted immediately** before it is saved — using AES-256-GCM encryption, which is the same standard used in banking.
- The key is **never shown to anyone** after it has been saved — not to teachers, not to students, and not to us.
- When a student uses the AI tutor, the server uses the key silently in the background to make the AI request and returns only the AI's response. The key itself never passes to the student's browser.

### Teacher accounts

- Passwords are hashed (scrambled one-way) before being stored — even we cannot read them.
- After **5 wrong password attempts**, an account is automatically locked for 15 minutes.
- Teachers can optionally enable **two-step login** (an authenticator app on their phone), adding an extra layer of security.
- Teachers can reset forgotten passwords themselves via a secure email link that expires in 1 hour.

### Student access

- Students have no passwords and no accounts — they cannot log in to anything outside their own class session.
- A student's session is tied to the class they joined. They cannot access any other class, any teacher view, or any other student's work.

### School data isolation

- Each school's data is completely separate. One school cannot see another school's students, classes, tasks, or any other information.
- If a school's account is ever suspended, **all access is blocked instantly** — every teacher at that school is locked out on their next login.

### Audit trail

Every significant action — logins, password changes, account lockouts — is recorded in an audit log with a timestamp and IP address. Your IT admin can review this log at any time.

---

## GDPR & Data Retention

### What data is held

| Data | Who it belongs to | Where it is stored |
|---|---|---|
| Teacher names and email addresses | The school | AWS (encrypted at rest) |
| Student first names | The school | AWS (encrypted at rest) |
| Student work (stage responses, chat history) | The school | AWS (encrypted at rest) |
| AI API key | The school | AWS (AES-256-GCM encrypted) |

### What data we do NOT hold

- Student surnames, dates of birth, or any other identifying information beyond the first name a student types at login.
- Any data from other schools.
- Your school's AI key in readable form — it is encrypted the moment it is entered.

### Data controller

Your school is the **data controller** for all student and staff data held within your school's account. We act as a **data processor** on your behalf, following your instructions and your school's data protection policies.

### Data retention

Student work and session data is retained for as long as your school account is active. Your IT admin can delete individual student sessions or request full data deletion at any time by contacting us.

### Right to erasure

If a student or parent requests deletion of data under GDPR Article 17, your IT admin can remove that student's session and all associated work from within the platform. No data is retained in backups beyond 30 days.

---

*For further questions about data protection, security architecture, or your school's data processing agreement, please contact us.*
