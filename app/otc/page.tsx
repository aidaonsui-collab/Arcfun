import { redirect } from 'next/navigation'

/** OTC desk is unwired from the product. APIs and keeper stay; visitors go home. */
export default function OtcRedirect() {
  redirect('/')
}
