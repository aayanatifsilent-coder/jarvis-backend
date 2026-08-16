// Run this ONCE on your PC to get a refresh token for Gmail + Calendar access.
// Usage: node get-refresh-token.js
//
// Before running:
// 1. Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are already in your .env
//    (from console.cloud.google.com -> Credentials -> OAuth client ID -> Desktop app)
//
// What happens:
// - This prints a URL. Open it in your browser, log into your Google account,
//   approve access, and Google will show you a short code.
// - Paste that code back into the terminal when prompted.
// - It prints a refresh token — copy that into your .env as GOOGLE_REFRESH_TOKEN.
// This only needs to be done once; the refresh token doesn't expire from normal use.

import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';
dotenv.config();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
);

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly'
];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // forces a refresh_token to be returned every time
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Log in, approve access, and copy the code Google shows you.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here: ', async (code) => {
    try {
        const { tokens } = await oauth2Client.getToken(code.trim());
        console.log('\nSuccess! Add this line to your .env file:\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } catch (err) {
        console.error('Error retrieving token:', err.message);
    }
    rl.close();
});
