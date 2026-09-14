import { getSelectionAndTouch } from '@/lib/pronote/store';
import { generateIcsForSelections } from '@/lib/pronote/ics';

/**
 * GET /api/calendar/{token} — flux .ics personnalisé d'un élève.
 * Appelé périodiquement par le client calendrier (Apple/Google Calendar),
 * en pull, pas en push — voir docs/architecture.md §6.
 */
export async function GET(request, { params }) {
  const { token } = await params;
  const donnees = await getSelectionAndTouch(token);

  if (!donnees) {
    return new Response('Lien inconnu ou expiré', { status: 404 });
  }

  const ics = await generateIcsForSelections(donnees.selections);

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="hyperics.ics"',
      // Pas de cache : le client calendrier doit revenir chercher les
      // dernières données à chaque fois qu'il rafraîchit son abonnement.
      'Cache-Control': 'no-store',
    },
  });
}
