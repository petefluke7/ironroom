const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Connecting to database...');
    try {
        const users = await prisma.user.findMany({
            include: {
                subscriptions: {
                    where: { isActive: true },
                    orderBy: { expiryDate: 'desc' },
                    take: 1
                },
                roomMemberships: {
                    include: { room: { select: { name: true } } }
                }
            }
        });

        console.log(`Found ${users.length} users.\n`);

        users.forEach(u => {
            console.log(`User: ${u.displayName} (${u.email})`);
            console.log(`  ID: ${u.id}`);
            console.log(`  Active: ${u.isActive}, Suspended: ${u.isSuspended}`);

            const sub = u.subscriptions[0];
            if (sub) {
                console.log(`  Subscription: ${sub.planType} (Expires: ${sub.expiryDate.toISOString().split('T')[0]})`);
            } else {
                console.log(`  Subscription: ❌ NONE/EXPIRED`);
            }

            if (u.roomMemberships.length > 0) {
                console.log(`  Member of ${u.roomMemberships.length} rooms:`);
                u.roomMemberships.forEach(rm => console.log(`    - ${rm.room.name}`));
            } else {
                console.log(`  Member of ❌ NO ROOMS`);
            }
            console.log('-'.repeat(40));
        });

    } catch (e) {
        console.error('Error during debug:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
