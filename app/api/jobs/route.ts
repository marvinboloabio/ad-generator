import { listJobs } from '@/lib/jobStore'

export async function GET() {
  return Response.json(listJobs())
}
