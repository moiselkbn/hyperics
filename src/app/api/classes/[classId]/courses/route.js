import { NextResponse } from 'next/server';
import { getCoursesForClass } from '@/lib/pronote/store';

/** GET /api/classes/{classId}/courses — cours en cache d'une classe. */
export async function GET(request, { params }) {
  const { classId } = await params;
  const courses = await getCoursesForClass(decodeURIComponent(classId));

  if (!courses) {
    return NextResponse.json({ error: 'Classe inconnue ou pas encore scrapée' }, { status: 404 });
  }

  return NextResponse.json({ courses });
}
