#!/bin/bash
# Create test bookings - just run this file, no setup needed

SUPABASE_URL="https://dqlefeafzvjberhjqdps.supabase.co"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxbGVmZWFmenZqYmNyaHFoZHBzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE3NDU2NCwiZXhwIjoyMDk2NzUwNTY0fQ.waRvnvFj0ovUnGUy-3e1AguVLlC3yRvCRjij9xo401M"

echo "Creating test bookings..."

create_booking() {
  local BUSINESS=$1
  local NAME=$2

  echo ""
  echo "📝 Creating for $NAME..."

  # Get business ID
  BIZ=$(curl -s "$SUPABASE_URL/rest/v1/businesses?slug=eq.$BUSINESS&select=id" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY")
  BIZ_ID=$(echo "$BIZ" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$BIZ_ID" ]; then
    echo "  ❌ Failed"
    return 1
  fi

  # Get first active tech
  TECHS=$(curl -s "$SUPABASE_URL/rest/v1/technicians?business_id=eq.$BIZ_ID&active=eq.true&select=id,name&limit=1" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY")
  TECH_ID=$(echo "$TECHS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  TECH_NAME=$(echo "$TECHS" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)

  # Create customer
  EMAIL="test-$(date +%s%N)@example.com"
  NAME_CUST="Test Customer $(($RANDOM % 9000 + 1000))"
  PHONE="(555) $(($RANDOM % 9000 + 1000))"

  CUST=$(curl -s -X POST "$SUPABASE_URL/rest/v1/customers?select=id" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"business_id\":\"$BIZ_ID\",\"name\":\"$NAME_CUST\",\"email\":\"$EMAIL\",\"phone\":\"$PHONE\",\"address_line1\":\"123 Main St\",\"city\":\"Denver\",\"state\":\"CO\",\"postal_code\":\"80202\"}")
  CUST_ID=$(echo "$CUST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  # Create booking for tomorrow at 10am
  TOMORROW=$(date -u -d '+1 day' +"%Y-%m-%dT10:00:00Z" 2>/dev/null || date -u -v+1d +"%Y-%m-%dT10:00:00Z")
  END=$(date -u -d '+1 day +2 hours' +"%Y-%m-%dT12:00:00Z" 2>/dev/null || date -u -v+1d -v+2H +"%Y-%m-%dT12:00:00Z")

  BOOK=$(curl -s -X POST "$SUPABASE_URL/rest/v1/bookings?select=id" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"business_id\":\"$BIZ_ID\",\"customer_id\":\"$CUST_ID\",\"technician_id\":\"$TECH_ID\",\"scheduled_at\":\"$TOMORROW\",\"scheduled_end\":\"$END\",\"status\":\"confirmed\",\"payment_status\":\"unpaid\",\"price\":155,\"customer_name\":\"$NAME_CUST\",\"customer_phone\":\"$PHONE\",\"customer_email\":\"$EMAIL\",\"address_line1\":\"123 Main St\",\"city\":\"Denver\",\"state\":\"CO\",\"postal_code\":\"80202\"}")
  BOOK_ID=$(echo "$BOOK" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$BOOK_ID" ]; then
    echo "  ❌ Failed to create booking"
    return 1
  fi

  # Add line items
  curl -s -X POST "$SUPABASE_URL/rest/v1/booking_line_items" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "[{\"booking_id\":\"$BOOK_ID\",\"business_id\":\"$BIZ_ID\",\"name\":\"TV Mount Installation\",\"quantity\":1,\"unit_price\":75,\"line_total\":75},{\"booking_id\":\"$BOOK_ID\",\"business_id\":\"$BIZ_ID\",\"name\":\"Wall Prep & Cable\",\"quantity\":1,\"unit_price\":80,\"line_total\":80}]" > /dev/null

  echo "  ✅ $NAME: Booking $BOOK_ID"
  echo "     Tech: $TECH_NAME"
  echo "     Customer: $NAME_CUST"
  echo "     Tomorrow 10am-12pm"
  echo "     Price: \$155"
}

create_booking "handy-andy" "Handy Andy"
create_booking "doms" "Doms"

echo ""
echo "✅ Done! Bookings created for both businesses."
echo ""
