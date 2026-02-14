const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Connecting to database...');
    try {
        // 1. Check total rooms
        const totalRooms = await prisma.room.count();
        console.log(`Total Rooms: ${totalRooms}`);

        // 2. Check active rooms
        const activeRooms = await prisma.room.count({ where: { isActive: true } });
        console.log(`Active Rooms: ${activeRooms}`);

        // 3. Get first user to simulate request
        const user = await prisma.user.findFirst();
        if (!user) {
            console.log('No users found in DB.');
            return;
        }
        console.log(`Simulating request for user: ${user.displayName} (${user.id})`);

        // 4. Run the exact query from rooms.js
        const rooms = await prisma.room.findMany({
            where: { isActive: true },
            select: {
                id: true,
                name: true,
                description: true,
                _count: { select: { members: true } },
                members: {
                    where: { userId: user.id },
                    select: { lastReadAt: true }
                }
            },
            orderBy: { createdAt: 'asc' },
        });

        console.log(`Query returned ${rooms.length} rooms.`);

        // 5. Simulate the mapping logic
        console.log('Simulating mapping logic...');
        const formatted = await Promise.all(rooms.map(async (room) => {
            const member = room.members[0];
            let unreadCount = 0;

            if (member && member.lastReadAt) {
                console.log(`Checking unread count for room ${room.name}...`);
                unreadCount = await prisma.roomMessage.count({
                    where: {
                        roomId: room.id,
                        createdAt: { gt: member.lastReadAt },
                        senderId: { not: user.id }
                    }
                });
            }

            return {
                id: room.id,
                name: room.name,
                description: room.description,
                activeParticipants: room._count.members,
                unreadCount,
                lastReadAt: member?.lastReadAt
            };
        }));

        console.log('Formatted response:', JSON.stringify(formatted, null, 2));

    } catch (e) {
        console.error('Error during debug:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
