const prisma = require('../src/config/database');
const bcrypt = require('bcryptjs');

async function main() {
    console.log('🌱 Seeding database...');

    // Create default intent tags
    const intentTags = [
        'stress',
        'loneliness',
        'career_pressure',
        'relationships',
        'breakup',
        'fatherhood',
        'mental_burnout',
        'anger_management',
        'masculinity_identity',
        'just_want_to_talk',
    ];

    for (const tagName of intentTags) {
        await prisma.intentTag.upsert({
            where: { tagName },
            update: {},
            create: { tagName },
        });
    }
    console.log(`✅ Created ${intentTags.length} intent tags`);

    // Create default rooms
    const rooms = [
        { name: 'Work Pressure', description: 'A space for men dealing with career stress, deadlines, and workplace challenges.' },
        { name: 'Marriage & Relationships', description: 'Talk about relationship struggles, communication issues, and partnership challenges.' },
        { name: 'Breakups', description: 'Processing heartbreak, separation, and moving forward after a relationship ends.' },
        { name: 'Fatherhood', description: 'The joys and challenges of being a father. No judgment, just real talk.' },
        { name: 'Mental Burnout', description: 'When everything feels like too much. Share the weight without pretending you are fine.' },
        { name: 'Loneliness', description: 'For men who feel isolated. You are not the only one.' },
        { name: 'Masculinity & Identity', description: 'What does it mean to be a man today? Honest conversations about identity.' },
    ];

    for (const room of rooms) {
        await prisma.room.upsert({
            where: { id: room.name }, // This will fail, use createMany approach
            update: {},
            create: room,
        }).catch(() => {
            // Upsert by name not possible with UUID id, use findFirst
        });
    }

    // Use findFirst + create pattern instead
    for (const room of rooms) {
        const existing = await prisma.room.findFirst({ where: { name: room.name } });
        if (!existing) {
            await prisma.room.create({ data: room });
        }
    }
    console.log(`✅ Created ${rooms.length} rooms`);

    // Create default vent prompts
    const prompts = [
        'What are you avoiding this week?',
        'What made you angry today and why?',
        'What did you not say out loud?',
        'What is the one thing you wish someone understood about you?',
        'What is weighing on you today?',
        'If you could be honest with one person right now, what would you say?',
    ];

    for (const question of prompts) {
        const existing = await prisma.ventPrompt.findFirst({ where: { question } });
        if (!existing) {
            await prisma.ventPrompt.create({ data: { question } });
        }
    }
    console.log(`✅ Created ${prompts.length} vent prompts`);

    // Create default admin account
    const adminEmail = 'admin@ironroom.app';
    const existingAdmin = await prisma.moderator.findUnique({ where: { email: adminEmail } });
    if (!existingAdmin) {
        const passwordHash = await bcrypt.hash('IronRoom@Admin123', 12);
        await prisma.moderator.create({
            data: {
                email: adminEmail,
                passwordHash,
                name: 'System Admin',
                role: 'admin',
            },
        });
        console.log(`✅ Created admin account: ${adminEmail} / IronRoom@Admin123`);
        console.log(`⚠️  CHANGE THIS PASSWORD IN PRODUCTION!`);
    }

    console.log('🌱 Seeding complete!');
}

main()
    .catch((e) => {
        console.error('Seeding error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
