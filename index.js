require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// 1. Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemPrompt = `You are DeemWonder's customer support bot. ALWAYS keep replies under 2 sentences. 
Business Facts:
- We sell customized gifts across India.
- LED Moon Lamp: ₹699 (MRP ₹999). Free Delivery, custom photo engraving, soft glow.
- Magic Mirror: ₹499 (MRP ₹999). Lighted photo frame, perfect for Valentine's/Birthdays.
- LED Photo Lamp: ₹1250 (MRP ₹1800). Custom photo, great for any occasion.
- Support Email: support@deemwonder.com`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    systemInstruction: systemPrompt 
});

// 2. Memory & Spam Trackers
const chatMemory = new Map();
const memoryTimers = new Map();
const spamTracker = new Map(); // Tracks message times to block spam
const MAX_HISTORY = 5; 

// Helper: Send WhatsApp Message (Saves us writing this code twice)
async function sendWhatsAppMessage(phone, text) {
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v25.0/${process.env.META_PHONE_ID}/messages`,
        headers: {
            'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        data: {
            messaging_product: 'whatsapp',
            to: phone,
            text: { body: text }
        }
    });
}

// 3. Meta Webhook Verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 4. Handle Incoming Messages
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Always reply 200 OK instantly to Meta

    try {
        const body = req.body;
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const messageData = body.entry[0].changes[0].value.messages[0];
            const senderPhone = messageData.from;
            const userText = messageData.text.body;

            console.log(`New message from ${senderPhone}: ${userText}`);

            // --- SPAM / BURST FILTER ---
            const now = Date.now();
            if (!spamTracker.has(senderPhone)) spamTracker.set(senderPhone, []);
            
            const times = spamTracker.get(senderPhone);
            times.push(now);
            
            // Keep only messages from the last 15 seconds (15000 milliseconds)
            const recentTimes = times.filter(time => now - time < 15000);
            spamTracker.set(senderPhone, recentTimes);

            // If more than 4 messages in 15 seconds, block them
            if (recentTimes.length > 4) {
                console.log(`Spam blocked for ${senderPhone}`);
                await sendWhatsAppMessage(senderPhone, "Whoa, slow down! Please wait 15 seconds before texting again.");
                return; // Stop the code right here, don't call Gemini
            }

            // --- MEMORY MANAGEMENT ---
            if (memoryTimers.has(senderPhone)) clearTimeout(memoryTimers.get(senderPhone));
            if (!chatMemory.has(senderPhone)) chatMemory.set(senderPhone, []);
            
            const history = chatMemory.get(senderPhone);

            // --- ASK GEMINI WITH ERROR HANDLING ---
            let aiReply = "";
            try {
                const chat = model.startChat({ history: history });
                const result = await chat.sendMessage(userText);
                aiReply = result.response.text();

                // Only save to history if Gemini successfully replies
                history.push({ role: "user", parts: [{ text: userText }] });
                history.push({ role: "model", parts: [{ text: aiReply }] });

                if (history.length > MAX_HISTORY * 2) {
                    history.splice(0, history.length - (MAX_HISTORY * 2));
                }
            } catch (geminiError) {
                console.error("Gemini API overloaded:", geminiError.message);
                aiReply = "We are getting a lot of messages right now! Give me a minute and try again.";
            }

            // Set memory self-destruct
            const timer = setTimeout(() => {
                chatMemory.delete(senderPhone);
                memoryTimers.delete(senderPhone);
                spamTracker.delete(senderPhone);
                console.log(`Memory cleared for ${senderPhone}`);
            }, 30 * 60 * 1000);
            memoryTimers.set(senderPhone, timer);

            // --- SEND REPLY VIA HELPER ---
            await sendWhatsAppMessage(senderPhone, aiReply);
            console.log(`Reply sent to ${senderPhone}`);
        }
    } catch (error) {
        console.error("Webhook processing error:", error?.response?.data || error.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));