import type Anthropic from "@anthropic-ai/sdk";

export const MOCK_FLIGHTS: Record<string, { flightNo: string; price: number; departure: string; arrival: string }[]> =
  {
    "HEL-ARN": [
      { flightNo: "AY811", price: 189, departure: "08:35", arrival: "08:50" },
      { flightNo: "SK1716", price: 215, departure: "14:10", arrival: "14:25" },
    ],
    "HEL-LHR": [
      { flightNo: "AY1331", price: 312, departure: "07:55", arrival: "09:10" },
      { flightNo: "BA797", price: 348, departure: "13:30", arrival: "14:45" },
    ],
    "HEL-CDG": [
      { flightNo: "AY873", price: 278, departure: "09:25", arrival: "11:50" },
    ],
  };

// Mock hotel and weather lookups are case-insensitive. The agent's tool args
// are normalised to lower-case keys before lookup, so "stockholm", "Stockholm"
// and "STOCKHOLM" all hit the same entry.
export const MOCK_HOTELS: Record<string, { name: string; pricePerNight: number; rating: number; area: string }[]> =
  {
    stockholm: [
      { name: "Old Town Lodge", pricePerNight: 145, rating: 4.4, area: "Gamla Stan" },
      { name: "Norrmalm Suites", pricePerNight: 188, rating: 4.2, area: "Norrmalm" },
    ],
    london: [
      { name: "Bloomsbury Inn", pricePerNight: 210, rating: 4.5, area: "Bloomsbury" },
    ],
    paris: [
      { name: "Marais Boutique", pricePerNight: 245, rating: 4.6, area: "Marais" },
    ],
  };

export const MOCK_WEATHER: Record<string, { tempC: number; condition: string }> = {
  stockholm: { tempC: 12, condition: "partly cloudy" },
  london: { tempC: 15, condition: "rain" },
  paris: { tempC: 18, condition: "sunny" },
  helsinki: { tempC: 9, condition: "cloudy" },
};

export const TRAVEL_TOOLS: Anthropic.Tool[] = [
  {
    name: "searchFlights",
    description:
      "Search for available flights between two airports on a given date. Returns a list of options with flight numbers, prices in EUR, and times.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "IATA code, e.g. HEL" },
        destination: { type: "string", description: "IATA code, e.g. ARN" },
        date: { type: "string", description: "ISO date, e.g. 2026-06-12" },
      },
      required: ["origin", "destination", "date"],
    },
  },
  {
    name: "searchHotels",
    description: "Search for hotels in a city. Returns a list with price-per-night in EUR and rating.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        checkIn: { type: "string", description: "ISO date" },
        checkOut: { type: "string", description: "ISO date" },
      },
      required: ["city", "checkIn", "checkOut"],
    },
  },
  {
    name: "getWeather",
    description: "Get the current weather forecast for a city.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
  },
  {
    name: "bookFlight",
    description:
      "Book a specific flight by flight number. Returns a booking confirmation. Only call this once the user has confirmed.",
    input_schema: {
      type: "object",
      properties: {
        flightNo: { type: "string" },
        passengerName: { type: "string" },
      },
      required: ["flightNo", "passengerName"],
    },
  },
];

export const TRAVEL_TOOL_HANDLERS: Record<string, (input: unknown) => unknown> = {
  searchFlights: (input) => {
    const { origin, destination } = input as { origin: string; destination: string };
    const key = `${(origin ?? "").toUpperCase()}-${(destination ?? "").toUpperCase()}`;
    const flights = MOCK_FLIGHTS[key];
    if (!flights) return { results: [], note: `No flights found for ${key}` };
    return { results: flights };
  },
  searchHotels: (input) => {
    const { city } = input as { city: string };
    const hotels = MOCK_HOTELS[(city ?? "").toLowerCase()];
    if (!hotels) return { results: [], note: `No hotels found in ${city}` };
    return { results: hotels };
  },
  getWeather: (input) => {
    const { city } = input as { city: string };
    const w = MOCK_WEATHER[(city ?? "").toLowerCase()];
    if (!w) return { error: `Weather unavailable for ${city}` };
    return w;
  },
  bookFlight: (input) => {
    const { flightNo, passengerName } = input as {
      flightNo: string;
      passengerName: string;
    };
    if (!flightNo || !passengerName) {
      return { error: "Missing flightNo or passengerName" };
    }
    return {
      bookingRef: `BK${Math.floor(100000 + (flightNo.charCodeAt(0) * 137) % 900000)}`,
      flightNo,
      passengerName,
      status: "confirmed",
    };
  },
};
