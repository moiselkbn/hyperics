// Outil de dev : lance le scraper en local et affiche un résumé.
// Usage : node scripts/test-scrape.mjs [nombre-de-classes]
import { scrapeAllClasses } from '../src/lib/pronote/scraper.js';

const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
const start = Date.now();

const { classes, coursesByClass } = await scrapeAllClasses({
  limit,
  onProgress: (label, i, total) => console.log(`[${i + 1}/${total}] ${label}`),
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const totalCourses = Object.values(coursesByClass).reduce((sum, c) => sum + c.length, 0);

console.log(`\n${classes.length} classes disponibles, ${Object.keys(coursesByClass).length} scrapées, ${totalCourses} cours au total.`);
console.log(`Temps écoulé : ${elapsed}s`);
