import { NextResponse } from 'next/server';
import { createSelection } from '@/lib/pronote/store';

/**
 * POST /api/selections — crée un lien élève (token) à partir d'une sélection.
 * Corps attendu : { selections: [{ classId, includedCourseUids? }, ...] }
 */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const selections = body?.selections;

  if (!Array.isArray(selections) || selections.length === 0) {
    return NextResponse.json({ error: 'selections manquant ou vide' }, { status: 400 });
  }
  for (const s of selections) {
    if (!s?.classId || typeof s.classId !== 'string') {
      return NextResponse.json({ error: 'Chaque sélection doit avoir un classId' }, { status: 400 });
    }
  }

  const token = await createSelection(selections);
  return NextResponse.json({ token });
}
