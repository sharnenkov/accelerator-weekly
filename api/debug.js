// Debug endpoint to check webhook state
export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = 'sharnenkov/accelerator-weekly';

  try {
    // Fetch current data-new.json
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/data-new.json?${Date.now()}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache'
        }
      }
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error: `GitHub API error: ${response.status}`,
        message: await response.text()
      });
    }

    const meta = await response.json();
    const content = Buffer.from(meta.content, 'base64').toString('utf8');
    const data = JSON.parse(content);

    // Return П26.02 data for inspection
    const pilot26_02 = data.pilots.control.find(p => p.id === 'АИ.П26.02');

    return res.status(200).json({
      status: 'ok',
      file: 'data-new.json',
      week: data.meta.week,
      pilot_26_02: pilot26_02,
      sha: meta.sha?.substring(0, 8),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
}
