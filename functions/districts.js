exports.districts = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { street, city, state, zip, lat, lng } = req.query;

  if (!lat && (!street || !state)) {
    return res.status(400).json({ error: 'Provide street+state or lat+lng' });
  }

  try {
    let match = null;

    if (street && state) {
      const addrParams = new URLSearchParams({
        street,
        city: city || '',
        state,
        zip: zip || '',
        benchmark: 'Public_AR_Current',
        vintage: 'Current_Current',
        format: 'json',
      });
      const addrUrl = 'https://geocoding.geo.census.gov/geocoder/geographies/address?' + addrParams.toString();
      const addrResp = await fetch(addrUrl);
      if (addrResp.ok) {
        const addrData = await addrResp.json();
        match = addrData?.result?.addressMatches?.[0];
      }
    }

    if (!match && lat && lng) {
      const coordParams = new URLSearchParams({
        x: lng,
        y: lat,
        benchmark: 'Public_AR_Current',
        vintage: 'Current_Current',
        format: 'json',
      });
      const coordUrl = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates?' + coordParams.toString();
      const coordResp = await fetch(coordUrl);
      if (coordResp.ok) {
        const coordData = await coordResp.json();
        const coordGeos = coordData?.result?.geographies;
        if (coordGeos) {
          match = {
            geographies: coordGeos,
            matchedAddress: `coordinates:${lat},${lng}`,
            coordinates: { x: parseFloat(lng), y: parseFloat(lat) },
          };
        }
      }
    }

    if (!match) {
      return res.status(200).json({ found: false, districts: [] });
    }

    const geos = match.geographies || {};
    const geoKeys = Object.keys(geos);
    const districts = [];

    const slduKey = geoKeys.find((k) => k.indexOf('State Legislative Districts - Upper') !== -1);
    const sldlKey = geoKeys.find((k) => k.indexOf('State Legislative Districts - Lower') !== -1);
    const cdKey = geoKeys.find((k) => k.indexOf('Congressional Districts') !== -1);

    if (slduKey && geos[slduKey]?.[0]) {
      const d = geos[slduKey][0];
      districts.push({ type: 'state-senate', number: d.DISTRICT || d.BASENAME || '', name: d.NAMELSAD || d.NAME || '' });
    }
    if (sldlKey && geos[sldlKey]?.[0]) {
      const d = geos[sldlKey][0];
      districts.push({ type: 'state-house', number: d.DISTRICT || d.BASENAME || '', name: d.NAMELSAD || d.NAME || '' });
    }
    if (cdKey && geos[cdKey]?.[0]) {
      const d = geos[cdKey][0];
      districts.push({ type: 'cd', number: d.DISTRICT || d.BASENAME || d.CD || '', name: d.NAMELSAD || d.NAME || '' });
    }

    // The same response names the county (5-digit FIPS in GEOID); the county
    // report card uses it when the address lookup gave no county.
    const countyKey = geoKeys.find((k) => k === 'Counties');
    const c = countyKey && geos[countyKey]?.[0];
    const county = c && /^\d{5}$/.test(c.GEOID || '') ? { fips: c.GEOID, name: c.NAME || '' } : null;

    return res.status(200).json({
      found: true,
      matchedAddress: match.matchedAddress,
      coordinates: match.coordinates,
      districts,
      county,
    });
  } catch (e) {
    console.error('Census geocoder error:', e);
    return res.status(500).json({ error: 'Census lookup failed' });
  }
};
