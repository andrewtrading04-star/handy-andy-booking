import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'Missing Supabase credentials' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // Get all events for the widget
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('widget', 'handy-andy');

    if (error) throw error;

    // Calculate funnel metrics
    const pageViews = events.filter(e => e.event_type === 'page_view').length;
    const priceDisplayed = events.filter(e => e.event_type === 'price_displayed').length;
    const bookingsConfirmed = events.filter(e => e.event_type === 'booking_confirmed').length;

    // Get unique sessions
    const uniqueSessions = new Set(events.map(e => e.session_id)).size;

    // Breakdown by device
    const deviceBreakdown = {};
    events.forEach(e => {
      const device = e.device_type || 'unknown';
      if (!deviceBreakdown[device]) {
        deviceBreakdown[device] = { page_view: 0, price_displayed: 0, booking_confirmed: 0 };
      }
      deviceBreakdown[device][e.event_type] = (deviceBreakdown[device][e.event_type] || 0) + 1;
    });

    // Breakdown by traffic source
    const sourceBreakdown = {};
    events.forEach(e => {
      const source = e.traffic_source || 'direct';
      if (!sourceBreakdown[source]) {
        sourceBreakdown[source] = { page_view: 0, price_displayed: 0, booking_confirmed: 0 };
      }
      sourceBreakdown[source][e.event_type] = (sourceBreakdown[source][e.event_type] || 0) + 1;
    });

    // Calculate conversion rates
    const step1to2 = priceDisplayed > 0 ? ((priceDisplayed / pageViews) * 100).toFixed(1) : '0';
    const step2to3 = bookingsConfirmed > 0 ? ((bookingsConfirmed / priceDisplayed) * 100).toFixed(1) : '0';
    const overallConversion = bookingsConfirmed > 0 ? ((bookingsConfirmed / pageViews) * 100).toFixed(1) : '0';

    // Top cities by bookings
    const cityBookings = {};
    events
      .filter(e => e.event_type === 'booking_confirmed' && e.city)
      .forEach(e => {
        cityBookings[e.city] = (cityBookings[e.city] || 0) + 1;
      });

    const topCities = Object.entries(cityBookings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    res.json({
      funnel: {
        pageViews,
        priceDisplayed,
        bookingsConfirmed,
        uniqueSessions,
      },
      conversions: {
        step1to2: parseFloat(step1to2),
        step2to3: parseFloat(step2to3),
        overall: parseFloat(overallConversion),
      },
      deviceBreakdown,
      sourceBreakdown,
      topCities,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
