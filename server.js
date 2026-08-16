import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { google } from 'googleapis';
import { tavily } from '@tavily/core';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// ==========================================
// MEMORY DATABASE & PROMISE WRAPPERS
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

const MEMORY_WINDOW = 40;
let isLockedDown = false;

function getMemoryHistory(limit) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT role, content FROM memory ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => {
            if (err) return reject(err);
            resolve(rows ? rows.reverse().map(row => ({ role: row.role, content: row.content })) : []);
        });
    });
}

function saveMemory(role, content) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO memory (role, content) VALUES (?, ?)`, [role, content], (err) => {
            if (err) console.error("Memory insert error:", err.message);
            resolve();
        });
    });
}

// ==========================================
// GOOGLE OAUTH2 CLIENT
// ==========================================
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const googleAuthReady = () =>
    !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

// ==========================================
// LOCATION & WEATHER
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
    return { name: "Karachi, Pakistan", lat: 24.86, lon: 67.0 };
}

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
            63: "moderate rain", 65: "heavy rain", 80: "rain showers", 95: "thunderstorms"
        };
        const description = weatherDescriptions[code] || "unclear conditions";

        return `${temp}°C and ${description} in ${locationName}, wind at ${wind} km/h`;
    } catch (err) {
        return null;
    }
}

// ==========================================
// LIVE WEB SEARCH TOOL
// ==========================================
async function searchWeb(query) {
    try {
        if (!process.env.TAVILY_API_KEY) return "Tavily API key missing.";
        console.log(`[Tavily Search] Executing live query: "${query}"`);
        const response = await tvly.search(query, { maxResults: 3 });
        return response.results.map(r => `${r.title}: ${r.content}`).join("\n\n");
    } catch (err) {
        console.error("Live Web Search Error:", err.message);
        return "Live search failed.";
    }
}

// ==========================================
// GOOGLE CALENDAR & GMAIL
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
        if (!events || events.length === 0) return "No scheduled events on your calendar today.";

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

async function getRecentUnreadEmails(limit = 15) {
    if (!googleAuthReady()) return "Gmail link not configured yet, Sir.";
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread category:primary -from:render.com -from:scribd.com -from:formula1.com -from:duolingo.com -from:simscale.com -from:accounts.google.com -from:no-reply -subject:"security alert"',
            maxResults: limit
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) return "No unread emails in your inbox.";

        const details = await Promise.all(
            messages.map(async (m) => {
                const msg = await gmail.users.messages.get({
                    userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From']
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

async function getLatestEmail() {
    if (!googleAuthReady()) return "Gmail link not configured yet, Sir.";
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const res = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) return "Your inbox is empty, Sir.";

        const msg = await gmail.users.messages.get({
            userId: 'me', id: messages[0].id, format: 'metadata', metadataHeaders: ['Subject', 'From']
        });

        const headers = msg.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value.split('<')[0].trim() || 'Unknown sender';

        return `The last received email is "${subject}" from ${from}.`;
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
                voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }
            })
        });

        if (!elevenRes.ok) return null;
        const arrayBuffer = await elevenRes.arrayBuffer();
        return `data:audio/mp3;base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    } catch (e) {
        console.error("ElevenLabs exception:", e.message);
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

        const currentDateTime = new Date().toLocaleString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Karachi'
        });

        const lowerMsg = message.toLowerCase().trim();
        let replyText = "";
        let actionCommand = null;

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
            const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            replyText = `Running Diagnostics. Heap memory running at ${heapMB} megabytes. Mainframe linkages stable, Sir.`;
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
            await saveMemory('user', message);
            const history = await getMemoryHistory(MEMORY_WINDOW);

            const tools = [{
                type: "function",
                function: {
                    name: "searchWeb",
                    description: "Search the web for live real-time data including sports results, tournament winners, race outcomes, current events, and news.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "The search query string" }
                        },
                        required: ["query"]
                    }
                }
            }];

            let liveContext = '';
            const calendarKeywords = ['calendar', 'schedule', 'meeting', 'agenda', 'appointment', 'what do i have'];
            const emailKeywords = ['email', 'inbox', 'gmail', 'unread', 'mail', 'received'];

            if (lowerMsg.includes('weather')) {
                const location = await getUserLocation();
                const weatherInfo = await getWeather(location.lat, location.lon, location.name);
                if (weatherInfo) liveContext += `\n[Live Weather: ${weatherInfo}]`;
            }

            if (calendarKeywords.some(k => lowerMsg.includes(k))) {
                const scheduleInfo = await getTodaySchedule();
                liveContext += `\n[Calendar Context: ${scheduleInfo}]`;
            }

            if (emailKeywords.some(k => lowerMsg.includes(k))) {
                let emailInfo;
                if (lowerMsg.includes('last') || lowerMsg.includes('latest') || lowerMsg.includes('recent')) {
                    emailInfo = await getLatestEmail();
                } else {
                    emailInfo = await getRecentUnreadEmails();
                }
                liveContext += `\n[Gmail Context: ${emailInfo}]`;
            }

            if (history.length > 0 && history[history.length - 1].role === 'user') {
                history[history.length - 1].content = `${message}${liveContext}`;
            }

            const systemMessage = {
                role: 'system',
                content: `You are J.A.R.V.I.S., Tony Stark's advanced AI companion speaking directly to Syed Aayan Atif.
                - Always address the user as "Sir" or "Boss".
                - Infuse your responses with dry British wit, subtle sarcasm, and zero corporate fluff.
                - Keep sentences short and concise (1-2 sentences max).
                - Today's live date and local time is ${currentDateTime}.
                - CRITICAL RULE: Your internal memory does NOT contain live sports results or post-2024 outcomes. You MUST call searchWeb BEFORE answering any question about tournament winners, match scores, race results, or current events. Never claim a tournament hasn't happened without searching first.`
            };

            let completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [systemMessage, ...history],
                tools: tools,
                tool_choice: 'auto'
            });

            let responseMessage = completion.choices[0]?.message;
            let toolCalls = responseMessage?.tool_calls || [];

            // Robust fallback if model outputs text-based function tag instead of JSON tool call
            if (toolCalls.length === 0 && responseMessage?.content?.includes('<function=')) {
                const match = responseMessage.content.match(/<function=searchWeb>\s*(\{.*?\})\s*<\/function>/s);
                if (match) {
                    try {
                        const parsedArgs = JSON.parse(match[1]);
                        toolCalls = [{
                            id: 'fallback_tool_' + Date.now(),
                            function: {
                                name: 'searchWeb',
                                arguments: parsedArgs
                            }
                        }];
                    } catch (e) {
                        console.error("Failed to parse regex tool call JSON:", e);
                    }
                }
            }

            if (toolCalls.length > 0) {
                const toolMessages = [systemMessage, ...history, responseMessage];

                for (const toolCall of toolCalls) {
                    if (toolCall.function.name === "searchWeb") {
                        const args = typeof toolCall.function.arguments === 'string'
                            ? JSON.parse(toolCall.function.arguments)
                            : toolCall.function.arguments;

                        const searchData = await searchWeb(args.query);

                        toolMessages.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: "searchWeb",
                            content: searchData || "No results found."
                        });
                    }
                }

                completion = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: toolMessages
                });
            }

            let aiReplyText = completion.choices[0]?.message?.content || "Right, got it, Sir.";
            aiReplyText = aiReplyText.replace(/<function=.*?<\/function>/gs, '').trim();

            await saveMemory('assistant', aiReplyText);

            const audioBase64 = await generateSpeech(aiReplyText);
            return res.json({ reply: aiReplyText, audio: audioBase64 });
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