// Plná adresa webu. Na GitHubu se odvodí z názvu repozitáře (proměnná
// GITHUB_REPOSITORY je tam vždy), vlastní doménu jde nastavit v SITE_URL.
export function adresaWebu(env = process.env) {
  const vlastni = env.SITE_URL;
  if (vlastni) return vlastni.endsWith('/') ? vlastni : `${vlastni}/`;
  const repo = env.GITHUB_REPOSITORY; // "vlastnik/nazev"
  if (repo && repo.includes('/')) {
    const [vlastnik, nazev] = repo.split('/');
    // repozitář pojmenovaný jmeno.github.io je přímo na kořeni domény
    if (nazev.toLowerCase() === `${vlastnik.toLowerCase()}.github.io`) return `https://${nazev.toLowerCase()}/`;
    return `https://${vlastnik.toLowerCase()}.github.io/${nazev}/`;
  }
  return '';
}
