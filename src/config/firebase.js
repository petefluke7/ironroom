const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
// Gracefully skip if credentials are not configured
let firebaseInitialized = false;

try {
    if (!admin.apps.length) {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY;

        if (projectId && clientEmail && privateKey) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey: privateKey.replace(/\\n/g, '\n'),
                }),
            });
            firebaseInitialized = true;
            console.log('✅ Firebase Admin SDK initialized');
        } else {
            console.warn('⚠️ Firebase credentials not configured — push notifications and phone auth disabled');
        }
    } else {
        firebaseInitialized = true;
    }
} catch (error) {
    console.error('❌ Firebase init error (non-fatal):', error.message);
}

admin.isInitialized = firebaseInitialized;
module.exports = admin;
