import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import types
import { ChantType, UserProfile, MILESTONES } from './src/types.js';

const app = express();
const PORT = 3000;

app.use(express.json());

// Prepare fallback local database file path
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Memory storage cache for fast access and fallback
let localDB: {
  profiles: { [uid: string]: UserProfile };
  chantLogs: { id: string; userId: string; chantType: ChantType; timestamp: number }[];
} = {
  profiles: {},
  chantLogs: []
};

// Initialize fallback from disk if available
if (fs.existsSync(DB_FILE)) {
  try {
    const fileData = fs.readFileSync(DB_FILE, 'utf8');
    localDB = JSON.parse(fileData);
  } catch (err) {
    console.error("Could not parse local db.json, starting clean:", err);
  }
}

function saveLocalDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(localDB, null, 2), 'utf8');
  } catch (err) {
    console.error("Failed to write to local db.json:", err);
  }
}

// Lazy-evaluation Firebase connection
let firestoreDb: any = null;
function getFirestoreDb() {
  if (firestoreDb) return firestoreDb;

  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (configJson && configJson.apiKey) {
        const firebaseApp = initializeApp(configJson);
        firestoreDb = getFirestore(firebaseApp);
        console.log("🔥 Connected server to Firebase Firestore database.");
        return firestoreDb;
      }
    } catch (err) {
      console.error("⚠️ Failed to parse firebase-applet-config.json, running local server DB:", err);
    }
  }
  return null;
}

// Secure state updater helpers
function getTodayDateKey(): string {
  // Returns date key in YYYY-MM-DD in UTC or user-aligned local time. Let's use clean YYYY-MM-DD.
  const now = new Date();
  return now.toISOString().split('T')[0];
}

function getYesterdayDateKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function syncProfileWithFirestore(uid: string, profile: UserProfile) {
  const db_instance = getFirestoreDb();
  if (db_instance) {
    try {
      const userRef = doc(db_instance, 'users', uid);
      await setDoc(userRef, profile, { merge: true });
    } catch (err) {
      console.error(`Firebase write error syncing uid: ${uid}:`, err);
    }
  }
}

const otpStore: { [mobile: string]: { code: string; expires: number } } = {};

async function fetchProfile(uid: string, fallbackEmail?: string, fallbackMobile?: string): Promise<UserProfile> {
  const today = getTodayDateKey();
  
  // Try Firebase first
  const db_instance = getFirestoreDb();
  if (db_instance) {
    try {
      const userRef = doc(db_instance, 'users', uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const profile = userSnap.data() as UserProfile;
        // Merge with local state cache
        localDB.profiles[uid] = profile;
        saveLocalDB();
        return profile;
      }
    } catch (err) {
      console.error("Firebase read error, trying fallback memory:", err);
    }
  }

  // Fallback to local database
  if (localDB.profiles[uid]) {
    return localDB.profiles[uid];
  }

  // Create absolute pristine default profile for new seekers
  const defaultProfile: UserProfile = {
    uid,
    displayName: fallbackEmail ? fallbackEmail.split('@')[0] : (fallbackMobile ? `Sadhaka ${fallbackMobile.slice(-4)}` : 'Meditator Seeker'),
    email: fallbackEmail || '',
    mobileNumber: fallbackMobile || '',
    totalChants: 0,
    currentStreak: 0,
    maxStreak: 0,
    milestonesEarned: [],
    targetDailyGoal: 108,
    lastChantedAt: null,
    dailyChantCounts: {}
  };

  localDB.profiles[uid] = defaultProfile;
  saveLocalDB();
  await syncProfileWithFirestore(uid, defaultProfile);
  return defaultProfile;
}

// ----- API ROUTES -----

// Health route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebaseLoaded: !!getFirestoreDb() });
});

// Auth - Send OTP
app.post('/api/auth/send-otp', (req, res) => {
  const { mobileNumber } = req.body;
  if (!mobileNumber) {
    return res.status(400).json({ error: "Mobile number is required" });
  }

  const cleanPhone = mobileNumber.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    return res.status(400).json({ error: "Please enter a valid mobile number with country code" });
  }

  // Generate 6-digit OTP code (standard random)
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  // Set expiry in 5 minutes
  const expires = Date.now() + 5 * 60 * 1000;

  otpStore[cleanPhone] = { code, expires };
  console.log(`📡 [OTP SERVER] Generated Verification Code for ${cleanPhone}: ${code}`);

  // In a preview environment, we return the generated OTP in the response
  // so the user can easily copy and paste it without needing external provider setups.
  res.json({
    success: true,
    message: "OTP sent successfully.",
    otp: code // For easy developer / user login in preview!
  });
});

// Auth - Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  const { mobileNumber, otp } = req.body;
  if (!mobileNumber || !otp) {
    return res.status(400).json({ error: "Mobile number and OTP match code are required" });
  }

  const cleanPhone = mobileNumber.replace(/\D/g, '');
  const cached = otpStore[cleanPhone];

  if (!cached) {
    return res.status(400).json({ error: "No OTP request found for this mobile number" });
  }

  if (Date.now() > cached.expires) {
    delete otpStore[cleanPhone];
    return res.status(400).json({ error: "Verification code expired. Please request a new OTP" });
  }

  if (cached.code !== otp.trim()) {
    return res.status(400).json({ error: "Invalid verification code" });
  }

  // Clean cache on success
  delete otpStore[cleanPhone];

  // Deterministic clean phone UID
  const uid = 'sadhaka_phone_' + cleanPhone;

  try {
    // Retrieve or create profile
    const profile = await fetchProfile(uid, undefined, cleanPhone);
    res.json({
      success: true,
      uid,
      profile
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to establish authenticated session" });
  }
});

// Profile - Get or Create Profile
app.get('/api/profile/:uid', async (req, res) => {
  const { uid } = req.params;
  const email = req.query.email as string | undefined;

  if (!uid || uid === 'undefined') {
    return res.status(400).json({ error: "Authenticated UID is required" });
  }

  try {
    const profile = await fetchProfile(uid, email);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to load profile" });
  }
});

// Profile - Update Profile (DisplayName, Daily Goal & Optional Mobile Number)
app.post('/api/profile/update', async (req, res) => {
  const { uid, displayName, targetDailyGoal, mobileNumber } = req.body;

  if (!uid) {
    return res.status(400).json({ error: "UID is required to update profile" });
  }

  try {
    const profile = await fetchProfile(uid);
    profile.displayName = displayName || profile.displayName;
    if (targetDailyGoal && Number(targetDailyGoal) > 0) {
      profile.targetDailyGoal = Number(targetDailyGoal);
    }
    if (mobileNumber !== undefined) {
      profile.mobileNumber = mobileNumber || profile.mobileNumber;
    }

    localDB.profiles[uid] = profile;
    saveLocalDB();

    await syncProfileWithFirestore(uid, profile);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to update profile" });
  }
});

// Log Chant - Secure, Anti-Hack verification router
app.post('/api/chant/log', async (req, res) => {
  const { uid, chantType } = req.body;

  if (!uid || !chantType) {
    return res.status(400).json({ error: "Missing required UID or Chant Type fields" });
  }

  const now = Date.now();
  const today = getTodayDateKey();
  const yesterday = getYesterdayDateKey();

  try {
    const profile = await fetchProfile(uid);
    const lastChantTime = profile.lastChantedAt || 0;

    // MANDATORY HACK-PROOF VERIFICATION: Enforce 1 second distance minimum
    const diff = now - lastChantTime;
    if (lastChantTime > 0 && diff < 950) { // 950ms allows minor network/jitter timing deviation but keeps 1s constraint solid
      return res.status(429).json({
        error: "Chant repeated too quickly! Please focus on the breath and divine rhythm. Chants are restricted to maximum 1 repetition per second.",
        hackLock: true,
        remainingMs: 950 - diff
      });
    }

    // Logic: Increment Stats
    profile.lastChantedAt = now;
    profile.totalChants += 1;

    // Daily Count Tracking
    if (!profile.dailyChantCounts) {
      profile.dailyChantCounts = {};
    }
    profile.dailyChantCounts[today] = (profile.dailyChantCounts[today] || 0) + 1;

    // Streak Calculation
    let lastChantDateKey = 'none';
    if (lastChantTime > 0) {
      const lastChantDate = new Date(lastChantTime);
      lastChantDateKey = lastChantDate.toISOString().split('T')[0];
    }

    if (profile.currentStreak === 0) {
      // Commencing streak
      profile.currentStreak = 1;
    } else if (lastChantDateKey === yesterday) {
      // Continuing daily consistency!
      profile.currentStreak += 1;
    } else if (lastChantDateKey !== today && lastChantDateKey !== 'none') {
      // Streak broken (gap larger than 1 day)
      profile.currentStreak = 1;
    }
    // Note: If lastChantDateKey === today, the user already extended the streak, so we leave currentStreak as-is.

    // Max streak recorder
    if (profile.currentStreak > profile.maxStreak) {
      profile.maxStreak = profile.currentStreak;
    }

    // Milestone Unlock Evaluator
    const newlyUnlocked: string[] = [];
    if (!profile.milestonesEarned) {
      profile.milestonesEarned = [];
    }

    for (const ms of MILESTONES) {
      if (profile.totalChants >= ms.requiredChants && !profile.milestonesEarned.includes(ms.id)) {
        profile.milestonesEarned.push(ms.id);
        newlyUnlocked.push(ms.id);
      }
    }

    // Capture logs on Backend for validation trace
    localDB.chantLogs.push({
      id: `${uid}_${now}`,
      userId: uid,
      chantType: chantType as ChantType,
      timestamp: now
    });
    
    // Prune very old logs in array to keep memory consumption low
    if (localDB.chantLogs.length > 5000) {
      localDB.chantLogs.shift();
    }

    localDB.profiles[uid] = profile;
    saveLocalDB();

    // Synchronize updates immediately with Firestore
    await syncProfileWithFirestore(uid, profile);

    res.json({
      success: true,
      profile,
      newlyUnlocked,
      currentChantCount: profile.dailyChantCounts[today]
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to log chant" });
  }
});

// Get session frequency data
app.get('/api/stats/:uid', async (req, res) => {
  const { uid } = req.params;
  const daysLimit = Number(req.query.days || 7);

  if (!uid) {
    return res.status(400).json({ error: "UID is required for statistics" });
  }

  try {
    const profile = await fetchProfile(uid);
    const result: { date: string; chants: number }[] = [];
    
    // Construct sequential history of requested range
    const todayStr = getTodayDateKey();
    const today = new Date();

    for (let i = daysLimit - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const chants = profile.dailyChantCounts?.[dateKey] || 0;
      
      // Formatting date label for recharts (e.g. May 25)
      const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      result.push({ date: dayLabel, chants });
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to generate statistics data" });
  }
});

// Configure Vite middleware in dev and static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🧘 Chanting Server launched on port ${PORT}`);
  });
}

startServer();
