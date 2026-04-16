require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// 1. Setup Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Replace the text inside the brackets with your actual business facts
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

// 2. Memory Storage (The Brain)
const chatMemory = new Map();
const memoryTimers = new Map();
const MAX_HISTORY = 5; // Keeps the last 5 back-and-forth messages

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
    // Meta requires an instant 200 OK response, or it will keep resending the message
    res.sendStatus(200);

    try {
        const body = req.body;

        // Check if it's an actual message, ignore delivery read receipts
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const messageData = body.entry[0].changes[0].value.messages[0];
            const senderPhone = messageData.from;
            const userText = messageData.text.body;

            console.log(`New message from ${senderPhone}: ${userText}`);

            // --- MEMORY MANAGEMENT ---
            // Clear the old 30-minute timer for this customer
            if (memoryTimers.has(senderPhone)) {
                clearTimeout(memoryTimers.get(senderPhone));
            }

            // Create a fresh array if this is a new customer
            if (!chatMemory.has(senderPhone)) {
                chatMemory.set(senderPhone, []);
            }
            const history = chatMemory.get(senderPhone);

            // --- ASK GEMINI ---
            // Pass the chat history to Gemini so it remembers the context
            const chat = model.startChat({ history: history });
            const result = await chat.sendMessage(userText);
            const aiReply = result.response.text();

            // Save the new back-and-forth to memory
            history.push({ role: "user", parts: [{ text: userText }] });
            history.push({ role: "model", parts: [{ text: aiReply }] });

            // Sliding Window: Delete oldest messages if the array gets too big
            if (history.length > MAX_HISTORY * 2) {
                history.splice(0, history.length - (MAX_HISTORY * 2));
            }

            // Set the 30-minute self-destruct timer
            const timer = setTimeout(() => {
                chatMemory.delete(senderPhone);
                memoryTimers.delete(senderPhone);
                console.log(`Memory cleared for ${senderPhone}`);
            }, 30 * 60 * 1000); // 30 mins
            memoryTimers.set(senderPhone, timer);

            // --- SEND REPLY VIA META API ---
            await axios({
                method: 'POST',
                url: `https://graph.facebook.com/v25.0/${process.env.META_PHONE_ID}/messages`,
                headers: {
                    'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                data: {
                    messaging_product: 'whatsapp',
                    to: senderPhone,
                    text: { body: aiReply }
                }
            });

            console.log(`Reply sent to ${senderPhone}`);
        }
    } catch (error) {
        console.error("Error processing message:", error?.response?.data || error.message);
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));