import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import sqlite3 from 'sqlite3';

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

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        const voiceId = process.env.VOICE_ID;
        const apiKey = process.env.ELEVENLABS_API_KEY;

        if (!process.env.GROQ_API_KEY || !apiKey || !voiceId) {
            return res.status(500).json({ error: "Missing API keys or Voice ID in .env" });
        }

        // 1. Save user message to SQLite database memory
        db.run(`INSERT INTO memory (role, content) VALUES (?, ?)`, ['user', message]);

        // 2. Fetch past conversation history (last 10 messages) for context window
        db.all(`SELECT role, content FROM memory ORDER BY id DESC LIMIT 10`, async (err, rows) => {
            if (err) {
                console.error("Database read error:", err);
                return res.status(500).json({ error: 'Database read error' });
            }

            // Reverse rows to maintain chronological order for Groq
            const history = rows.reverse().map(row => ({
                role: row.role,
                content: row.content
            }));

            // 3. Detect Location
            const userLocation = await getUserLocation();

            // 4. Perform Web Search if needed
            const searchKeywords = ['weather', 'news', 'score', 'today', 'price', 'latest', 'who won', 'what is'];
            let searchContext = '';

            if (searchKeywords.some(keyword => message.toLowerCase().includes(keyword))) {
                const searchQuery = message.toLowerCase().includes('weather') 
                    ? `${message} in ${userLocation}`
                    : message;

                console.log(`Searching web for: "${searchQuery}"`);
                const snippetData = await searchWeb(searchQuery);
                if (snippetData) {
                    searchContext = `\n[Live Search Context: ${snippetData}]`;
                }
            }

            // Inject search context into the latest user message dynamically
            const fullUserContent = `${message}${searchContext}`;

            if (history.length > 0 && history[history.length - 1].role === 'user') {
                history[history.length - 1].content = fullUserContent;
            }

            // 5. Generate Fluid Response via Groq with full conversational history
            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `You are J.A.R.V.I.S., Tony Stark's advanced AI companion. You are speaking directly to Syed Aayan Atif.
                        - Always address the user as "Sir".
                        - Infuse your responses with dry British wit, subtle sarcasm, and zero corporate fluff.
                        - Keep sentences brutally short and concise (1-2 sentences max).
                        - Avoid all generic AI filler phrases.`
                    },
                    ...history
                ],
            });

            const replyText = completion.choices[0]?.message?.content || "Right, got it, Sir.";
            console.log(`JARVIS: "${replyText}"`);

            // 6. Save assistant response to SQLite database memory
            db.run(`INSERT INTO memory (role, content) VALUES (?, ?)`, ['assistant', replyText]);

            // 7. ElevenLabs Voice (Tuned for smooth continuous speech)
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
                const errText = await elevenRes.text();
                console.error('ElevenLabs API Error:', errText);
                return res.json({ reply: replyText, audio: null });
            }

            const arrayBuffer = await elevenRes.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);
            const audioBase64 = audioBuffer.toString('base64');

            res.json({
                reply: replyText,
                audio: `data:audio/mp3;base64,${audioBase64}`
            });
        });

    } catch (error) {
        console.error("JARVIS Engine Error:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`JARVIS Engine online on port ${PORT}`);
});