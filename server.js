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

// Initialize SQLite Memory Database
const db = new sqlite3.Database('./jarvis_memory.db', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Stark mainframe memory core initialized (SQLite).');
});

// Create table for permanent conversation history
db.run(`CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Global state tracking
let isLockedDown = false;

// Get visitor/server location automatically via IP
async function getUserLocation() {
    try {
        const res = await fetch('http://ip-api.com/json/');
        const data = await res.json();
        if (data && data.status === 'success') {
            return `${data.city}, ${data.country}`;
        }
    } catch (err) {
        console.warn("Could not fetch IP location, falling back...");
    }
    return "Unknown Location";
}

// Free DuckDuckGo search helper
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

// Helper: Fetch Google Calendar schedule for today
async function getTodaySchedule() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: './credentials.json',
            scopes: ['https://www.googleapis.com/auth/calendar.readonly']
        });
        const calendar = google.calendar({ version: 'v3', auth });

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
            const time = event.start.dateTime ? new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All day';
            return `${event.summary} at ${time}`;
        }).join(', ');

        return `Your calendar schedule includes: ${eventList}.`;
    } catch (error) {
        console.error("Calendar fetch error:", error.message);
        return "Calendar link offline.";
    }
}

// Helper: Fetch recent unread Gmail messages
async function getRecentUnreadEmails() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: './credentials.json',
            scopes: ['https://www.googleapis.com/auth/gmail.readonly']
        });
        const gmail = google.gmail({ version: 'v1', auth });

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread',
            maxResults: 3
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) {
            return "No unread emails in your inbox.";
        }

        let count = messages.length;
        return `You have ${count} unread email updates awaiting review.`;
    } catch (error) {
        console.error("Gmail fetch error:", error.message);
        return "Gmail link offline.";
    }
}

// Helper to generate ElevenLabs speech for any reply text
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

        if (!elevenRes.ok) return null;
        const arrayBuffer = await elevenRes.arrayBuffer();
        return `data:audio/mp3;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    } catch (e) {
        return null;
    }
}

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
            let weatherInfo = "Weather data link nominal.";
            try {
                const weatherRes = await searchWeb("weather today");
                if (weatherRes) weatherInfo = weatherRes.slice(0, 80);
            } catch (e) {}

            const scheduleInfo = await getTodaySchedule();
            const emailInfo = await getRecentUnreadEmails();

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

            db.all(`SELECT role, content FROM memory ORDER BY id DESC LIMIT 10`, async (err, rows) => {
                if (err) return res.status(500).json({ error: 'Database read error' });

                const history = rows.reverse().map(row => ({ role: row.role, content: row.content }));
                const userLocation = await getUserLocation();

                const searchKeywords = ['weather', 'news', 'score', 'today', 'price', 'latest', 'who won', 'what is', 'formula 1', 'f1'];
                let searchContext = '';

                if (searchKeywords.some(keyword => lowerMsg.includes(keyword))) {
                    const searchQuery = lowerMsg.includes('weather') ? `${message} in ${userLocation}` : message;
                    const snippetData = await searchWeb(searchQuery);
                    if (snippetData) searchContext = `\n[Live Search Context: ${snippetData}]`;
                }

                const fullUserContent = `${message}${searchContext}`;
                if (history.length > 0 && history[history.length - 1].role === 'user') {
                    history[history.length - 1].content = fullUserContent;
                }

                const completion = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        {
                            role: 'system',
                            content: `You are J.A.R.V.I.S., Tony Stark's advanced AI companion. You are speaking directly to Syed Aayan Atif.
                            - Always address the user as "Sir" or "Boss".
                            - Infuse your responses with dry British wit, subtle sarcasm, and zero corporate fluff.
                            - Keep sentences short and concise (1-2 sentences max).
                            - Avoid all generic AI filler phrases.`
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