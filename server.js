import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { google } from 'googleapis';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================================
// MEMORY DATABASE
// ==========================================
const db = new sqlite3.Database('./jarvis_memory.db', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Stark mainframe memory core initialized (SQLite).');
});

db.run(`CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// How many past messages JARVIS pulls into context (~20 exchanges).
const MEMORY_WINDOW = 40;

let isLockedDown = false;

// ==========================================
// GOOGLE OAUTH2 CLIENT (Gmail + Calendar)
// ==========================================
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const googleAuthReady = () =>
    !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

// ==========================================
// LOCATION (returns coords too, for weather)
// ==========================================
async function getUserLocation() {
    try {
        const res = await fetch('http://ip-api.com/json/');
        const data = await res.json();
        if (data && data.status === 'success') {
            return { name: `${data.city}, ${data.country}`, lat: data.lat, lon: data.lon };
        }
    } catch (err) {
        console.warn("Could not fetch IP location, falling back...");
    }
    return { name: "Karachi, Pakistan", lat: 24.86, lon: 67.0 }; // fallback
}

// ==========================================
// LIVE WEATHER (Open-Meteo — free, no API key)
// ==========================================
async function getWeather(lat, lon, locationName) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=celsius`;
        const res = await fetch(url);
        const data = await res.json();

        const code = data.current.weather_code;
        const temp = Math.round(data.current.temperature_2m);
        const wind = Math.round(data.current.wind_speed_10m);

        const weatherDescriptions = {
            0: "clear skies", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
            45: "foggy", 48: "foggy", 51: "light drizzle", 61: "light rain",
            63: "moderate rain", 65: "heavy rain", 80: "rain showers",
            95: "thunderstorms"
        };
        const description = weatherDescriptions[code] || "unclear conditions";

        return `${temp}°C and ${description} in ${locationName}, wind at ${wind} km/h`;
    } catch (err) {
        return null;
    }
}

// ==========================================
// LIVE WEB SEARCH (news/scores/general "what is" — not weather)
// ==========================================
async function searchWeb(query) {
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await res.text();
        const snippets = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/g)]
            .map(m => m[1].replace(/<[^>]+>/g, ''))
            .slice(0, 3)
            .join(' ');
        return snippets || null;
    } catch (err) {
        return null;
    }
}

// ==========================================
// GOOGLE CALENDAR (today's schedule)
// ==========================================
async function getTodaySchedule() {
    if (!googleAuthReady()) return "Calendar link not configured yet, Sir.";
    try {
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: startOfDay,
            timeMax: endOfDay,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items;
        if (!events || events.length === 0) {
            return "No scheduled events on your calendar today.";
        }

        const eventList = events.map(event => {
            const time = event.start.dateTime
                ? new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'All day';
            return `${event.summary} at ${time}`;
        }).join(', ');

        return `Your calendar schedule includes: ${eventList}.`;
    } catch (error) {
        console.error("Calendar fetch error:", error.message);
        return "Calendar link offline.";
    }
}

// ==========================================
// GMAIL (recent unread, Primary tab only, junk filtered)
// ==========================================
async function getConnectedEmailAddress() {
    if (!googleAuthReady()) return null;
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return profile.data.emailAddress;
    } catch (error) {
        console.error("Profile fetch error:", error.message);
        return null;
    }
}

async function getRecentUnreadEmails(limit = 15) {
    if (!googleAuthReady()) return "Gmail link not configured yet, Sir.";
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread category:primary -from:render.com -from:scribd.com -from:formula1.com -from:duolingo.com -from:simscale.com -from:accounts.google.com -from:no-reply -subject:"security alert" -subject:"account was recovered"',
            maxResults: 15
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) {
            return "No unread emails in your inbox.";
        }

        const details = await Promise.all(
            messages.slice(0, limit).map(async (m) => {
                const msg = await gmail.users.messages.get({
                    userId: 'me',
                    id: m.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From']
                });
                const headers = msg.data.payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
                const from = headers.find(h => h.name === 'From')?.value.split('<')[0].trim() || 'Unknown sender';
                return `"${subject}" from ${from}`;
            })
        );

        return `You have ${messages.length} unread emails. Top ones: ${details.join('; ')}.`;
    } catch (error) {
        console.error("Gmail fetch error:", error.message);
        return "Gmail link offline.";
    }
}

// ==========================================
// ELEVENLABS TTS
// ==========================================
async function generateSpeech(replyText) {
    const voiceId = process.env.VOICE_ID;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    try {
        const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=3`, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': apiKey,
            },
            body: JSON.stringify({
                text: replyText,
                model_id: 'eleven_flash_v2_5',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    style: 0.3,
                    use_speaker_boost: true
                }
            })
        });

        if (!elevenRes.ok) {
            const errorText = await elevenRes.text();
            console.error("ElevenLabs error:", elevenRes.status, errorText);
            return null;
        }
        const arrayBuffer = await elevenRes.arrayBuffer();
        return `data:audio/mp3;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    } catch (e) {
        console.error("ElevenLabs fetch exception:", e.message);
        return null;
    }
}

// ==========================================
// MAIN CHAT ENDPOINT
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        const voiceId = process.env.VOICE_ID;
        const apiKey = process.env.ELEVENLABS_API_KEY;

        if (!process.env.GROQ_API_KEY || !apiKey || !voiceId) {
            return res.status(500).json({ error: "Missing API keys or Voice ID in .env" });
        }

        const lowerMsg = message.toLowerCase().trim();
        let replyText = "";
        let actionCommand = null;

        // ==========================================
        // PROTOCOL HANDLERS (Bypasses AI if triggered)
        // ==========================================
        if (isLockedDown && !lowerMsg.includes('lift lockdown') && !lowerMsg.includes('unlock')) {
            replyText = "System under Code 404 Lockdown. Access denied, Sir.";
        }
        else if (lowerMsg.includes('code 404') || lowerMsg.includes('lockdown procedure')) {
            isLockedDown = true;
            replyText = "Lockdown Procedure Initiated. Shuts down JARVIS temporarily, Sir.";
        }
        else if (lowerMsg.includes('lift lockdown') || lowerMsg.includes('unlock system')) {
            isLockedDown = false;
            replyText = "Lockdown lifted. All systems back online, Sir.";
        }
        else if (lowerMsg.includes('clean slate')) {
            replyText = "Initiating Clean Slate Protocol, deleting notifications and cache.";
            actionCommand = "TRIGGER_CLEAN_SLATE";
        }
        else if (lowerMsg.includes('diagnostics') || lowerMsg.includes('system self check')) {
            const memoryUsage = process.memoryUsage();
            const heapMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
            replyText = `Running Diagnostics. System self checks operational. Heap memory running at ${heapMB} megabytes. All mainframe linkages stable, Sir.`;
        }
        else if (lowerMsg.includes('briefing 101') || lowerMsg.includes('morning briefing')) {
            const location = await getUserLocation();
            const weatherInfo = await getWeather(location.lat, location.lon, location.name) || "Weather data link nominal.";

            const scheduleInfo = await getTodaySchedule();
            const emailInfo = await getRecentUnreadEmails(5);

            replyText = `Good morning, Sir. Briefing 101 engaged. Current status: ${weatherInfo}. ${scheduleInfo} ${emailInfo} All systems optimal, Sir.`;
        }
        else if (lowerMsg.includes('focus mode')) {
            replyText = "Focus Mode is activated, Do Not Disturb is ON.";
            actionCommand = "TRIGGER_DND_ON";
        }
        else {
            // ==========================================
            // STANDARD AI & LIVE DATA PIPELINE
            // ==========================================
            db.run(`INSERT INTO memory (role, content) VALUES (?, ?)`, ['user', message]);

            db.all(`SELECT role, content FROM memory ORDER BY id DESC LIMIT ?`, [MEMORY_WINDOW], async (err, rows) => {
                if (err) return res.status(500).json({ error: 'Database read error' });

                const history = rows.reverse().map(row => ({ role: row.role, content: row.content }));

                const searchKeywords = ['news', 'score', 'today', 'price', 'latest', 'who won', 'what is', 'formula 1', 'f1'];
                const calendarKeywords = ['calendar', 'schedule', 'meeting', 'agenda', 'appointment', 'what do i have'];
                const emailKeywords = ['email', 'inbox', 'gmail', 'unread', 'mail'];

                let liveContext = '';

                if (lowerMsg.includes('weather')) {
                    const location = await getUserLocation();
                    const weatherInfo = await getWeather(location.lat, location.lon, location.name);
                    if (weatherInfo) liveContext += `\n[Live Weather: ${weatherInfo}]`;
                } else if (searchKeywords.some(k => lowerMsg.includes(k))) {
                    const snippetData = await searchWeb(message);
                    if (snippetData) liveContext += `\n[Live Search Context: ${snippetData}]`;
                }

                if (calendarKeywords.some(k => lowerMsg.includes(k))) {
                    const scheduleInfo = await getTodaySchedule();
                    liveContext += `\n[Calendar Context: ${scheduleInfo}]`;
                }

                if (emailKeywords.some(k => lowerMsg.includes(k))) {
                    const emailInfo = await getRecentUnreadEmails();
                    liveContext += `\n[Gmail Context: ${emailInfo}]`;
                }

                const fullUserContent = `${message}${liveContext}`;
                if (history.length > 0 && history[history.length - 1].role === 'user') {
                    history[history.length - 1].content = fullUserContent;
                }

                const completion = await groq.chat.completions.create({
                    model: 'qwen-3.6-27b',
                    messages: [
                        {
                            role: 'system',
                            content: `You are J.A.R.V.I.S., Tony Stark's advanced AI companion. You are speaking directly to Syed Aayan Atif.
                            - Always address the user as "Sir" or "Boss".
                            - Infuse your responses with dry British wit, subtle sarcasm, and zero corporate fluff.
                            - Keep sentences short and concise (1-2 sentences max).
                            - Avoid all generic AI filler phrases.
                            - If given [Live Search Context], [Live Weather], [Calendar Context], or [Gmail Context] in the user's message, use that real data to answer — don't say you can't access it.`
                        },
                        ...history
                    ],
                });

                const aiReplyText = completion.choices[0]?.message?.content || "Right, got it, Sir.";
                db.run(`INSERT INTO memory (role, content) VALUES (?, ?)`, ['assistant', aiReplyText]);

                const audioBase64 = await generateSpeech(aiReplyText);
                return res.json({ reply: aiReplyText, audio: audioBase64 });
            });
            return;
        }

        const audioBase64 = await generateSpeech(replyText);
        res.json({ reply: replyText, audio: audioBase64, action: actionCommand });

    } catch (error) {
        console.error("JARVIS Engine Error:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`JARVIS Engine online on port ${PORT}`);
});