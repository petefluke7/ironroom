const firebaseAdmin = require('../config/firebase');
const prisma = require('../config/database');

/**
 * Send push notification to a user via FCM
 */
async function sendPushNotification(userId, notification) {
    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { fcmToken: true },
        });

        if (!user?.fcmToken) {
            console.log(`No FCM token for user ${userId}, skipping push notification`);
            return;
        }

        const message = {
            token: user.fcmToken,
            notification: {
                title: notification.title,
                body: notification.body,
            },
            data: notification.data || {},
            android: {
                priority: 'high',
                notification: {
                    channelId: 'ironroom_messages',
                },
            },
            apns: {
                payload: {
                    aps: {
                        badge: 1,
                        sound: 'default',
                    },
                },
            },
        };

        await firebaseAdmin.messaging().send(message);
        console.log(`📱 Push notification sent to user ${userId}`);
    } catch (error) {
        if (error.code === 'messaging/registration-token-not-registered') {
            // Token is invalid, clear it
            await prisma.user.update({
                where: { id: userId },
                data: { fcmToken: null },
            });
        }
        console.error(`Failed to send push notification to ${userId}:`, error.message);
    }
}

/**
 * Send notification to multiple users
 */
async function sendBulkNotification(userIds, notification) {
    const promises = userIds.map((userId) => sendPushNotification(userId, notification));
    await Promise.allSettled(promises);
}

module.exports = { sendPushNotification, sendBulkNotification };
