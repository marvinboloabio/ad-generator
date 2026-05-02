import { getAuthUrl } from '@/lib/googleDrive'

export async function GET() {
  const url = getAuthUrl()
  return Response.redirect(url)
}
