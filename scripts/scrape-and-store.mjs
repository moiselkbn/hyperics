// Script exécuté par le cron GitHub Actions (1x/h, 6h-18h) : scrape toutes
// les classes PRONOTE et écrit le résultat dans Redis.
// Usage : node scripts/scrape-and-store.mjs [nombre-de-classes-max]
import { scrapeAllClasses } from '../src/lib/pronote/scraper.js';
import { saveScrapeResult, closeStore } from '../src/lib/pronote/store.js';

const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
const start = Date.now();

try {
  const resultat = await scrapeAllClasses({
    limit,
    onProgress: (label, i, total) => console.log(`[${i + 1}/${total}] ${label}`),
  });

  await saveScrapeResult(resultat);

  const totalCourses = Object.values(resultat.coursesByClassId).reduce((sum, c) => sum + c.length, 0);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(
    `\n✅ ${resultat.classes.length} classes, ${totalCourses} cours écrits dans Redis en ${elapsed}s.`,
  );
} catch (err) {
  console.error('❌ Échec du scraping:', err);
  process.exitCode = 1;
} finally {
  await closeStore();
}
