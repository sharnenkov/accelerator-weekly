// API route to fetch data from GitHub (bypasses CORS issues)
export default async function handler(req, res) {
  const { file = 'data-new.json' } = req.query;

  // Validate filename to prevent directory traversal
  if (!['data.json', 'data-new.json'].includes(file)) {
    return res.status(400).json({ error: 'Invalid file' });
  }

  try {
    const url = `https://raw.githubusercontent.com/sharnenkov/accelerator-weekly/main/${file}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'accelerator-bot' }
    });

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const data = await response.json();

    // Set CORS headers to allow frontend access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    return res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching from GitHub:', err);
    return res.status(500).json({ error: err.message });
  }
}
