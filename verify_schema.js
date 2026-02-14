const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Connecting to database...');
    try {
        const result = await prisma.$queryRaw`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'profile_picture_url';
    `;

        console.log('\n--- Verification Result ---');
        if (result.length > 0) {
            console.log('✅ SUCCESS: Column "profile_picture_url" was found in table "users".');
            console.log('Details:', result[0]);
        } else {
            console.log('❌ FAILURE: Column "profile_picture_url" was NOT found.');
        }
    } catch (e) {
        console.error('Error querying database:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
