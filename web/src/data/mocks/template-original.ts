/**
 * Placeholder content for the home page.
 *
 * Every string here is transcribed from the Get Layers file — the hero from
 * frame "Hero 2" (774:254), the destinations block from "Hero 2 (Block 2:
 * Destinations)" (1600:34461), the philosophy block from "Hero 2 (Block 3:
 * Philosophy)" (1653:964 and 1653:1003), the travel block from the five
 * "Hero 2 (Block 4: How We Travel)" frames. Swap this module for real data without
 * touching the components — they take it all through props.
 */

import {
  INK,
  STICKER_Z,
} from "@/views/home/destinations/destinations.geometry";
import type {
  Destination,
  DestinationsContent,
  StickerAsset,
} from "@/views/home/destinations/destinations.types";
import type { HeroContent } from "@/views/home/hero/hero.types";
import type { PhilosophyContent } from "@/views/home/philosophy/philosophy.types";
import type { PlanContent } from "@/views/home/plan/plan.types";
import type { TravelContent } from "@/views/home/travel/travel.types";

export const heroContent: HeroContent = {
  // Node 854:950 — italic leading capitals, roman remainder.
  wordmark: [
    { text: "W", italic: true },
    { text: "ander" },
    { text: "L", italic: true },
    { text: "ust" },
  ],

  // Node 881:9
  nav: [
    { label: "JOURNAL.", href: "/journal" },
    { label: "EXPERIENCES.", href: "/experiences" },
    { label: "ABOUT.", href: "/about" },
    { label: "CONTACT.", href: "/contact" },
  ],

  // Node 881:3 / 856:958 — lowercase in Figma, uppercased in CSS.
  explore: { label: "explore Destinations", href: "/destinations" },

  // Node 854:953
  titleStart: [
    { text: "B", italic: true },
    { text: "eyond " },
    { text: "P", italic: true },
    { text: "laces" },
  ],

  // Node 854:954 — two lines.
  titleEnd: [
    [{ text: "I", italic: true }, { text: "nto" }],
    [{ text: "M", italic: true }, { text: "oments" }],
  ],

  cardCaptionTop: ["TRAVEL STORIES", "JOURNAL"], // 857:998
  cardCaptionBottom: ["01.", "REAL JOURNEYS", "42."], // 857:997

  destinationsLabel: "ALL DESTINATIONS", // 856:995
  // 856:996, 869:1120/1123/1127
  destinations: [
    { label: "Iceland", href: "/destinations/iceland" },
    { label: "Norway", href: "/destinations/norway" },
    { label: "Japan", href: "/destinations/japan" },
    { label: "Indonesia", href: "/destinations/indonesia" },
  ],

  // Node 856:988
  viewModes: [
    { label: "SLIDER", active: true },
    { label: "LIST", active: false },
  ],

  media: {
    video: {
      src: "/assets/hero/Hero-video.mp4",
      alt: "Travel footage: a glacial river valley seen from the air",
      width: 2560,
      height: 1440,
    },
    /*
     * The clip's own last frame, at the clip's own 2560×1440 — matched to it
     * frame-for-frame so the dissolve changes only how much detail is there.
     */
    still: {
      src: "/assets/hero/hero-final-frame.jpg",
    },
    thumbnail: {
      src: "/assets/hero/hero-thumb2.png",
      alt: "A traveller raising a camera over a glacial river valley",
      width: 1440,
      height: 800,
    },
  },
};

/* ---------------------------------------------------------------------------
   BLOCK 2 — Destinations (frame 1784:1916)
   --------------------------------------------------------------------------- */

/**
 * Sixteen countries, one card each, every card on the scene at once.
 *
 * `cx`/`cy` are the centre of the card's **ink** in frame coordinates, and
 * `width` is that ink's width. No height: it comes from the photograph's own
 * proportions through `INK`, so a card can never be drawn to a shape its file
 * does not have. No rotation either — every export is already turned.
 *
 * `z` is the paint order the frame draws them in, 1 at the bottom. It is not
 * the reading order: Portugal is drawn first and numbered eighth.
 *
 * > [!warning] These centres were corrected against a render of the frame
 * > The table they were entered from carried the rotated-leaf error the block's
 * > docs are about: for a rotated leaf `get_metadata` reports the x of the
 * > rotated rectangle's own corner rather than the left edge of the box it
 * > occupies, and the two differ by `height × sin θ`. Card by card that came to
 * > **22px** for eight of them, 19 for Morocco, 12 for Italy and Japan, and 0 for
 * > Switzerland and Norway — which is exactly the pattern of their rotations.
 * >
 * > Every centre here is the offset that minimises the pixel difference against
 * > a 1440×687 render of 1784:1916, searched ±30px. Fourteen of the sixteen land
 * > at **0,0** residual; the whole scene came from MAD 30.89 to **7.43**.
 * >
 * > Greece and New Zealand are the two that cannot be pinned this way — their
 * > drawn heights disagree with their photographs, see destinations.md — so
 * > theirs are the best alignment available for the shape they have.
 *
 * The alt text names the caption printed on the card rather than describing the
 * photograph, which is the one thing about these files that can be stated
 * without seeing them.
 */
const destinations: Destination[] = [
  {
    id: "iceland",
    name: "ICELAND",
    card: {
      src: "/assets/Block2/Iceland.png",
      alt: "A polaroid captioned Iceland",
      cx: 982.59,
      cy: 370.28,
      width: 212.092,
      z: 7,
      ink: INK["Iceland"],
    },
  },
  {
    id: "norway",
    name: "NORWAY",
    card: {
      src: "/assets/Block2/Norway.png",
      alt: "A polaroid captioned Norway",
      cx: 311.23,
      cy: 116.27,
      width: 177.669,
      z: 11,
      ink: INK["Norway"],
    },
  },
  {
    id: "japan",
    name: "JAPAN",
    card: {
      src: "/assets/Block2/Japan.png",
      alt: "A polaroid captioned Japan",
      cx: 441.86,
      cy: 352.08,
      width: 193.726,
      z: 15,
      ink: INK["Japan"],
    },
  },
  {
    id: "morocco",
    name: "MOROCCO",
    card: {
      src: "/assets/Block2/Morocco.png",
      alt: "A polaroid captioned Morocco",
      cx: 381.73,
      cy: 551.64,
      width: 191.631,
      z: 16,
      ink: INK["Morocco"],
    },
  },
  {
    id: "switzerland",
    name: "SWITZERLAND",
    card: {
      src: "/assets/Block2/Switzerland.png",
      alt: "A polaroid captioned Switzerland",
      cx: 164.38,
      cy: 44.99,
      width: 223.278,
      z: 13,
      ink: INK["Switzerland"],
    },
  },
  {
    id: "italy",
    name: "ITALY",
    card: {
      src: "/assets/Block2/Italy.png",
      alt: "A polaroid captioned Italy",
      cx: 292.65,
      cy: 406.16,
      width: 185.295,
      z: 10,
      ink: INK["Italy"],
    },
  },
  {
    id: "france",
    name: "FRANCE",
    card: {
      src: "/assets/Block2/France.png",
      alt: "A polaroid captioned France",
      cx: 723.58,
      cy: 413.78,
      width: 208.139,
      z: 4,
      ink: INK["France"],
    },
  },
  {
    id: "portugal",
    name: "PORTUGAL",
    card: {
      src: "/assets/Block2/Portugal.png",
      alt: "A polaroid captioned Portugal",
      cx: 1154.05,
      cy: 544.61,
      width: 212.092,
      z: 1,
      ink: INK["Portugal"],
    },
  },
  {
    id: "spain",
    name: "SPAIN",
    card: {
      src: "/assets/Block2/Spain.png",
      alt: "A polaroid captioned Spain",
      cx: 867.36,
      cy: 398.36,
      width: 144.16,
      z: 8,
      ink: INK["Spain"],
    },
  },
  {
    id: "greece",
    name: "GREECE",
    card: {
      src: "/assets/Block2/Greece.png",
      alt: "A polaroid captioned Greece",
      cx: 1285.05,
      cy: 82.61,
      width: 212.092,
      z: 14,
      ink: INK["Greece"],
    },
  },
  {
    id: "austria",
    name: "AUSTRIA",
    card: {
      src: "/assets/Block2/Austria.png",
      alt: "A polaroid captioned Austria",
      cx: 1164.92,
      cy: 137.61,
      width: 211.111,
      z: 12,
      ink: INK["Austria"],
    },
  },
  {
    id: "canada",
    name: "CANADA",
    card: {
      src: "/assets/Block2/Canada.png",
      alt: "A polaroid captioned Canada",
      cx: 802.95,
      cy: 566.67,
      width: 182.347,
      z: 5,
      ink: INK["Canada"],
    },
  },
  {
    id: "new-zealand",
    name: "NEW ZEALAND",
    card: {
      src: "/assets/Block2/New Zealand.png",
      alt: "A polaroid captioned New Zealand",
      cx: 1381.78,
      cy: 137.49,
      width: 197.924,
      z: 3,
      ink: INK["New Zealand"],
    },
  },
  {
    id: "australia",
    name: "AUSTRALIA",
    card: {
      src: "/assets/Block2/Australia.png",
      alt: "A polaroid captioned Australia",
      cx: 1065.79,
      cy: 471.88,
      width: 172.42,
      z: 6,
      ink: INK["Australia"],
    },
  },
  {
    id: "slovenia",
    name: "SLOVENIA",
    card: {
      src: "/assets/Block2/Slovenia.png",
      alt: "A polaroid captioned Slovenia",
      cx: 576.63,
      cy: 452.42,
      width: 208.582,
      z: 9,
      ink: INK["Slovenia"],
    },
  },
  {
    id: "istanbul",
    name: "ISTANBUL",
    card: {
      src: "/assets/Block2/Istanbul.png",
      alt: "A polaroid captioned Istanbul",
      cx: 654.54,
      cy: 319.71,
      width: 190.046,
      z: 2,
      ink: INK["Istanbul"],
    },
  },
];

/**
 * The three marks that belong to no country and sit above every card.
 *
 * Centre and size straight from the frame — `image 587`, `Basic stamp` and
 * `image 585` at the top level of 1784:1916 — with **no ink correction**. Each
 * file already has exactly the ratio its box is given, so the box goes to the
 * file whole. See `StickerAsset`.
 *
 * These three moved when the frame was redrawn, and the numbers that came with
 * the brief were the old frame's: the stamp's 631.76 and the flag's 1080 are
 * recorded against the previous version in destinations.md's rotated-leaf table.
 *
 * The frame's own numbers then needed the correction that table is about. For a
 * **rotated leaf** `get_metadata` reports the x of the rotated rectangle's own
 * corner, not the left edge of the box it occupies, and the two differ by
 * `height × sin θ`. Measured against a 1440×687 render of the frame by colour
 * centroid — the stamp's green, the lupin's violet — the lupin sat 18.5px right
 * (66.319 × sin 16.2°) and the stamp 11.1px (47.111 × sin 13.6°). Both are
 * subtracted here. The flag is not rotated and needed nothing, which is the same
 * result the old frame's table recorded for it.
 *
 * `STICKER_Z` puts them over the pile at rest; a raised card comes above them,
 * which is what `RAISED_Z` is for.
 */
const destinationStickers: StickerAsset[] = [
  {
    src: "/assets/Block2/Sticker1-art.png",
    alt: "",
    cx: 364.53,
    cy: 328.1594,
    width: 54.6133,
    height: 66.3188,
    z: STICKER_Z,
  },
  {
    src: "/assets/Block2/Sticker3.png",
    alt: "",
    cx: 618.97,
    cy: 347.5557,
    width: 40.6249,
    height: 47.1114,
    z: STICKER_Z,
  },
  {
    src: "/assets/Block2/Sticker4.png",
    alt: "",
    cx: 1075.5,
    cy: 338.5,
    width: 35,
    height: 29,
    z: STICKER_Z,
  },
];

export const destinationsContent: DestinationsContent = {
  // Two lines, italic leading capitals. Unchanged by the redraw.
  heading: [
    [{ text: "D", italic: true }, { text: "estinations" }],
    [
      { text: "W", italic: true },
      { text: "orth " },
      { text: "W", italic: true },
      { text: "andering" },
    ],
  ],

  // 01–08 fill the left column, 09–16 the right.
  countries: destinations,
  stickers: destinationStickers,
};

/* ---------------------------------------------------------------------------
   BLOCK 3 — Philosophy (frames 1653:964 and 1653:1003)
   --------------------------------------------------------------------------- */

/**
 * The heading, segmented so the leading capital of every word takes the italic
 * cut: G, S, T, S, W, Y. Same alternation as the hero's display type, which is
 * why it reuses `SegmentedText` rather than growing its own renderer.
 */
const philosophyTitle: PhilosophyContent["title"] = [
  [
    { text: "G", italic: true },
    { text: "o " },
    { text: "S", italic: true },
    { text: "omewhere " },
    { text: "T", italic: true },
    { text: "hat " },
  ],
  [
    { text: "S", italic: true },
    { text: "tays " },
  ],
  [
    { text: "W", italic: true },
    { text: "ith " },
    { text: "Y", italic: true },
    { text: "ou" },
  ],
];

export const philosophyContent: PhilosophyContent = {
  title: philosophyTitle,

  asideLeft: [
    "We plan trips for the moments you'll still ",
    "talk about years later.",
  ],
  asideRight: [
    "The quiet mornings, the unexpected turns, ",
    "the places you almost didn't find.",
  ],

  signOff: ["Less ticking places off a list.", "More actually being there."],

  media: {
    backdrop: {
      src: "/assets/Block 3/pexels-arthousestudio-4344885.jpg",
      alt: "A glacial river braiding across a green valley, seen from the air",
      width: 5760,
      height: 6400,
    },
    collage: {
      src: "/assets/Block 3/Collage.png",
      alt: "A polaroid of a traveller with her arms outstretched, taped over torn notebook pages",
      width: 1504,
      height: 1616,
    },
  },
};

/* ---------------------------------------------------------------------------
   BLOCK 4 — How We Travel (frames 1678:1116, 1680:1248, 1680:1323,
   1686:1365, 1686:1393)
   --------------------------------------------------------------------------- */

/**
 * Each panel's heading, segmented so the leading capital of every word takes the
 * italic cut — S·G·T, R·T, H·S, L·E. Same alternation as the hero and block 3,
 * which is why they all reuse `SegmentedText`.
 *
 * `bodyWidth` is Figma's own measure for the body column, and it differs per
 * panel because each width is the one that breaks its sentence into the four
 * lines the file draws.
 */
export const travelContent: TravelContent = {
  // Node 1680:1329 — italic H, W, T.
  title: [
    { text: "H", italic: true },
    { text: "ow " },
    { text: "W", italic: true },
    { text: "e " },
    { text: "T", italic: true },
    { text: "ravel" },
  ],

  // Node 1680:1334
  subtitle: "Different trips, same intention.",

  panels: [
    {
      id: "small-group-trips",
      title: [
        { text: "S", italic: true },
        { text: "mall " },
        { text: "G", italic: true },
        { text: "roup " },
        { text: "T", italic: true },
        { text: "rips" },
      ],
      body: "We travel in small groups so everyone feels included, heard and free to be themselves.",
      signOff: "More connection, less crowd.",
      bodyWidth: 390,
      media: {
        src: "/assets/Block4/OpenedImage1.png",
        alt: "Four travellers in bright rain jackets cheering on a mossy clifftop above a canyon",
      },
    },
    {
      id: "road-trips",
      title: [
        { text: "R", italic: true },
        { text: "oad " },
        { text: "T", italic: true },
        { text: "rips" },
      ],
      body: "Scenic roads, unexpected stops and the freedom to change the plan when it feels right.",
      signOff: "The best views aren't on Google Maps.",
      bodyWidth: 420,
      media: {
        src: "/assets/Block4/OpenedImage2.png",
        alt: "A white car alone on a road across black sand, under a jagged mountain ridge",
      },
    },
    {
      id: "handpicked-stays",
      title: [
        { text: "H", italic: true },
        { text: "andpicked " },
        { text: "S", italic: true },
        { text: "tays" },
      ],
      body: "We choose places with soul. Local, beautiful, comfortable and run by people who care.",
      signOff: "Stay somewhere you'll remember.",
      bodyWidth: 400,
      media: {
        src: "/assets/Block4/OpenedImage3.png",
        alt: "A traveller standing on wet rocks beside a turquoise waterfall",
      },
    },
    {
      id: "local-experiences",
      title: [
        { text: "L", italic: true },
        { text: "ocal " },
        { text: "E", italic: true },
        { text: "xperiences" },
      ],
      body: "We meet local people, try real food, learn the stories and see the places that don't make it to the guidebooks.",
      signOff: "The heart of the journey.",
      bodyWidth: 490,
      media: {
        src: "/assets/Block4/OpenedImage4.png",
        alt: "Four people around a picnic table with warm mugs, snow-dusted hills behind them",
      },
    },
  ],
};

/* ---------------------------------------------------------------------------
   BLOCK 5 — Plan a Journey + footer (frame 1705:253)
   --------------------------------------------------------------------------- */

/** The asset folder, spelled the way it sits on disk — with the space. */
const BLOCK_5 = "/assets/Block 5";

export const planContent: PlanContent = {
  // Node 1705:258 — italic P and J, black rather than cream.
  title: [
    { text: "P", italic: true },
    { text: "lan a " },
    { text: "J", italic: true },
    { text: "ourney" },
  ],

  // Node 1705:263 / 1705:261 — both uppercased in CSS, not in the copy.
  note: [
    "Tell us what you're",
    "dreaming of. We'll shape",
    "the journey.",
  ],
  noteAside: "ready when you are",

  // Node 1705:270
  action: { label: "Start planning", href: "/plan" },

  footer: {
    // The hero's wordmark, same segmentation.
    wordmark: [
      { text: "W", italic: true },
      { text: "ander" },
      { text: "L", italic: true },
      { text: "ust" },
    ],

    // Nodes 1705:277 / 284 / 291. Widths live in plan.geometry.ts.
    columns: [
      {
        title: "DESTINATIONS",
        links: [
          { label: "Iceland", href: "/destinations/iceland" },
          { label: "Norway", href: "/destinations/norway" },
          { label: "Japan", href: "/destinations/japan" },
          { label: "Indonesia", href: "/destinations/indonesia" },
        ],
      },
      {
        title: "EXPERIENCES",
        links: [
          { label: "Adventure", href: "/experiences/adventure" },
          { label: "Nature", href: "/experiences/nature" },
          { label: "Culture", href: "/experiences/culture" },
          { label: "Slow Travel", href: "/experiences/slow-travel" },
        ],
      },
      {
        title: "COMPANY",
        links: [
          { label: "About Us", href: "/about" },
          { label: "Journal", href: "/journal" },
          { label: "Testimonials", href: "/testimonials" },
          { label: "Contact", href: "/contact" },
        ],
      },
    ],

    // Node 1705:299 / 1705:301
    newsletter: "Stories, guides & ideas for wherever you're headed next.",
    emailPlaceholder: "Your e-mail",
    emailAction: "Subscribe",

    // Nodes 1705:305 / 310 / 313 — Instagram, Facebook, YouTube, read off the
    // marks themselves. TODO: the account URLs are placeholders.
    social: [
      { src: `${BLOCK_5}/SocialMedia1.svg`, alt: "Wanderlust on Instagram", href: "#" },
      { src: `${BLOCK_5}/SocialMedia2.svg`, alt: "Wanderlust on Facebook", href: "#" },
      { src: `${BLOCK_5}/SocialMedia3.png`, alt: "Wanderlust on YouTube", href: "#" },
    ],

    // Node 1705:274
    copyright: "© 2024 Wanderlust. All rights reserved.",
  },

  media: {
    backdrop: {
      src: `${BLOCK_5}/BackgroundImage.png`,
      alt: "A green ridge running down into cloud",
    },
    far: {
      src: `${BLOCK_5}/03_mountains_midground 1.png`,
      alt: "A ridge of mountains behind low cloud",
    },
    steam: {
      src: `${BLOCK_5}/02_steam_screen_blend 1.png`,
      alt: "",
    },
    foreground: {
      src: `${BLOCK_5}/01_foreground 1.png`,
      alt: "",
    },
    note: {
      src: `${BLOCK_5}/Pin.png`,
      alt: "A handwritten note pinned to the view",
    },
    underlines: [
      { src: `${BLOCK_5}/Vector1.svg`, alt: "" },
      { src: `${BLOCK_5}/Vector2.svg`, alt: "" },
    ],
    arrow: { src: `${BLOCK_5}/Icon1.svg`, alt: "" },
  },
};
