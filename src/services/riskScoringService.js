const prisma = require('../config/database');

/**
 * Risk Scoring Service
 * Calculates and updates user risk scores based on behavior patterns
 */

/**
 * Recalculate risk score for a user
 */
async function recalculateRiskScore(userId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Count reports received in last 30 days
    const reportsCount = await prisma.report.count({
        where: {
            targetUserId: userId,
            createdAt: { gte: thirtyDaysAgo },
        },
    });

    // Count how many unique users blocked this person
    const blocksCount = await prisma.blockedUser.count({
        where: {
            blockedId: userId,
            createdAt: { gte: thirtyDaysAgo },
        },
    });

    // Count warnings in last 30 days
    const warningsCount = await prisma.warning.count({
        where: {
            userId,
            createdAt: { gte: thirtyDaysAgo },
        },
    });

    // Calculate score
    let score = 0;
    score += reportsCount * 5;   // +5 per report
    score += blocksCount * 3;    // +3 per block
    score += warningsCount * 10; // +10 per warning

    // Subtract for clean activity (no reports/blocks in last 30 days = -10)
    if (reportsCount === 0 && blocksCount === 0 && warningsCount === 0) {
        score = Math.max(0, score - 10);
    }

    await prisma.user.update({
        where: { id: userId },
        data: { riskScore: score },
    });

    return score;
}

/**
 * Get risk level from score
 */
function getRiskLevel(score) {
    if (score >= 30) return 'high';
    if (score >= 15) return 'medium';
    return 'low';
}

module.exports = { recalculateRiskScore, getRiskLevel };
