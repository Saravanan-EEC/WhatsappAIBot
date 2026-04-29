require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Server is awake!');
});

// 1. Setup Gemini with Secret Trigger Codes
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const systemPrompt = `You are DeemWonder's customer support agent, act like a real human. ALWAYS keep replies under 2 sentences with minimal words. dont be rude. 
Business Facts:
- We sell customized gifts across India.
- LED Moon Lamp: ₹699 (MRP ₹999). Free Delivery.
- Magic Mirror: ₹499 (MRP ₹999).
- LED Photo Lamp: ₹1250 (MRP ₹1800)
- Support Email: support@deemwonder.com

CRITICAL INSTRUCTION: 
If the customer asks to see or buy a specific product, answer them normally, but you MUST add exactly one of these secret codes at the very end of your reply:
- For Magic Mirror: [SEND_MAGIC_MIRROR]
- For Moon Lamp: [SEND_MOON_LAMP]
- For Photo Lamp: [SEND_PHOTO_LAMP]`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite-preview", 
    systemInstruction: systemPrompt 
});

// 2. Trackers
const chatMemory = new Map();
const memoryTimers = new Map();
const spamTracker = new Map();
const dailyMessageCount = new Map(); 
const pendingSheetUpdates = new Map(); 
const processedMessages = new Set(); 
const messageBuffer = new Map(); 
const MAX_HISTORY = 5; 
const DAILY_LIMIT = 40;

// 3. Google Sheets Setup
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);

// 4. Background Batch Updater
async function processSheetBatch() {
    if (pendingSheetUpdates.size > 0) {
        const updatesToProcess = new Map(pendingSheetUpdates);
        pendingSheetUpdates.clear(); 

        try {
            await doc.loadInfo(); 
            const sheet = doc.sheetsByIndex[0]; 
            const rows = await sheet.getRows();
            const newCustomers = [];

            for (const [phone, data] of updatesToProcess.entries()) {
                const existingRow = rows.find(row => row.get('Phone Number') === phone);

                if (existingRow) {
                    existingRow.assign({
                        'Last Update': data.time,
                        'Last Message': data.message,
                        'Daily Message Count': data.count
                    });
                    await existingRow.save(); 
                } else {
                    newCustomers.push({
                        'Phone Number': phone,
                        'Last Update': data.time,
                        'Status': 'Browsing',
                        'Last Message': data.message,
                        'Order Details': 'None yet',
                        'Daily Message Count': data.count
                    });
                }
            }

            if (newCustomers.length > 0) {
                await sheet.addRows(newCustomers);
            }
            console.log(`Successfully batch updated ${updatesToProcess.size} records.`);
        } catch (err) {
            console.error("Google Sheets Batch Error:", err.message);
            updatesToProcess.forEach((value, key) => pendingSheetUpdates.set(key, value));
        }
    }
    setTimeout(processSheetBatch, 15000);
}
setTimeout(processSheetBatch, 15000);

// Helper: Send Text Message
async function sendWhatsAppMessage(phone, text) {
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v25.0/${process.env.META_PHONE_ID}/messages`,
        headers: {
            'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        data: { messaging_product: 'whatsapp', to: phone, text: { body: text } }
    });
}

// Helper: Send Interactive Catalog Product
async function sendProductMessage(phone, catalogId, contentId) {
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
            type: 'interactive',
            interactive: {
                type: 'product',
                action: {
                    catalog_id: catalogId,
                    product_item_retailer_id: contentId
                }
            }
        }
    });
}

// Helper: Process the glued message
async function processFinalMessage(senderPhone, finalUserText) {
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    
    if (!dailyMessageCount.has(senderPhone)) {
        try {
            await doc.loadInfo(); 
            const sheet = doc.sheetsByIndex[0]; 
            const rows = await sheet.getRows();
            const existingRow = rows.find(row => row.get('Phone Number') === senderPhone);

            if (existingRow) {
                const sheetDate = existingRow.get('Last Update').split(',')[0].trim();
                if (sheetDate === today) {
                    const sheetCount = parseInt(existingRow.get('Daily Message Count'), 10) || 0;
                    dailyMessageCount.set(senderPhone, { date: today, count: sheetCount });
                }
            }
        } catch (err) {
            console.error("RAM Recovery Error:", err.message);
        }
    }

    let userTracking = dailyMessageCount.get(senderPhone) || { date: today, count: 0 };
    if (userTracking.date !== today) userTracking = { date: today, count: 0 };
    
    userTracking.count += 1;
    dailyMessageCount.set(senderPhone, userTracking);

    if (userTracking.count > DAILY_LIMIT) {
        console.log(`${senderPhone} hit the 40 message limit.`);
        await sendWhatsAppMessage(senderPhone, "You've reached the daily limit! Email us at support@deemwonder.com");
        return;
    }

    const timeString = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    pendingSheetUpdates.set(senderPhone, {
        time: timeString,
        message: finalUserText,
        count: userTracking.count 
    });

    if (memoryTimers.has(senderPhone)) clearTimeout(memoryTimers.get(senderPhone));
    if (!chatMemory.has(senderPhone)) chatMemory.set(senderPhone, []);
    const history = chatMemory.get(senderPhone);

    let aiReply = "";
    try {
        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(finalUserText);
        aiReply = result.response.text();

        history.push({ role: "user", parts: [{ text: finalUserText }] });
        history.push({ role: "model", parts: [{ text: aiReply }] });

        if (history.length > MAX_HISTORY * 2) {
            history.splice(0, history.length - (MAX_HISTORY * 2));
        }
    } catch (geminiError) {
        console.error("Gemini API Error:", geminiError.message);
        aiReply = "Give me just a second and try again!";
    }

    // --- NEW: PRODUCT INTERCEPTOR ---
    let productToSend = null;
    const catalogID = '1276433380786865';

    if (aiReply.includes('[SEND_MAGIC_MIRROR]')) {
        productToSend = 'kgvvw73wvx';
        aiReply = aiReply.replace('[SEND_MAGIC_MIRROR]', '').trim();
    } else if (aiReply.includes('[SEND_MOON_LAMP]')) {
        productToSend = 'gwyc5286y5';
        aiReply = aiReply.replace('[SEND_MOON_LAMP]', '').trim();
    } else if (aiReply.includes('[SEND_PHOTO_LAMP]')) {
        productToSend = '1qpfyatk1u';
        aiReply = aiReply.replace('[SEND_PHOTO_LAMP]', '').trim();
    }

    // Send the clean text first
    await sendWhatsAppMessage(senderPhone, aiReply);

    // Send the catalog product right after if triggered
    if (productToSend) {
        await sendProductMessage(senderPhone, catalogID, productToSend);
    }

    const timer = setTimeout(() => {
        chatMemory.delete(senderPhone);
        memoryTimers.delete(senderPhone);
        spamTracker.delete(senderPhone);
    }, 30 * 60 * 1000);
    memoryTimers.set(senderPhone, timer);
}

// 5. Meta Webhook Verification
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// 6. Handle Incoming Messages
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); 

    try {
        const body = req.body;
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const messageData = body.entry[0].changes[0].value.messages[0];
            const senderPhone = messageData.from;
            const messageId = messageData.id;

            if (processedMessages.has(messageId)) return; 
            processedMessages.add(messageId);
            setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

            if (messageData.type !== 'text') return; 

            const userText = messageData.text.body;

            const now = Date.now();
            if (!spamTracker.has(senderPhone)) spamTracker.set(senderPhone, []);
            const times = spamTracker.get(senderPhone);
            times.push(now);
            const recentTimes = times.filter(time => now - time < 15000);
            spamTracker.set(senderPhone, recentTimes);

            if (recentTimes.length > 6) {
                console.log(`Spam blocked for ${senderPhone}`);
                await sendWhatsAppMessage(senderPhone, "Whoa, slow down! Please wait 15 seconds before texting again.");
                return; 
            }

            if (!messageBuffer.has(senderPhone)) {
                messageBuffer.set(senderPhone, { text: userText, timer: null });
            } else {
                const current = messageBuffer.get(senderPhone);
                current.text += " " + userText; 
                clearTimeout(current.timer);
            }

            const currentBuffer = messageBuffer.get(senderPhone);
            currentBuffer.timer = setTimeout(async () => {
                try {
                    const finalMessage = currentBuffer.text;
                    messageBuffer.delete(senderPhone); 
                    console.log(`Sending glued message to AI: ${finalMessage}`);
                    await processFinalMessage(senderPhone, finalMessage);
                } catch (err) {
                    console.error("Buffer error:", err.message);
                }
            }, 3000);
        }
    } catch (error) {
        console.error("Webhook error:", error?.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));