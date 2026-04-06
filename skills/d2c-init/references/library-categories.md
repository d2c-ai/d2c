# Library Categories Reference

This file is loaded by d2c-init Step 5a when scanning package.json for installed libraries.

**Known categories and their members (this is a starting reference, NOT an exhaustive list):**

| Category | Known libraries |
|----------|----------------|
| data_fetching | `@tanstack/react-query`, `@tanstack/query`, `swr`, `axios`, `@apollo/client`, `urql`, `graphql-request` |
| realtime | `ably`, `socket.io-client`, `pusher-js`, `@supabase/realtime-js`, `firebase`, `@firebase/messaging` |
| state_management | `zustand`, `@reduxjs/toolkit`, `redux`, `jotai`, `recoil`, `mobx`, `mobx-react`, `valtio`, `xstate` |
| forms | `react-hook-form`, `formik`, `@tanstack/react-form`, `final-form`, `react-final-form` |
| validation | `zod`, `yup`, `joi`, `superstruct`, `valibot`, `@sinclair/typebox` |
| dates | `date-fns`, `dayjs`, `moment`, `luxon`, `@date-io/date-fns`, `@date-io/dayjs`, `@date-io/moment` |
| animation | `framer-motion`, `react-spring`, `@react-spring/web`, `gsap`, `motion`, `auto-animate`, `@formkit/auto-animate` |
| icons | `lucide-react`, `react-icons`, `@heroicons/react`, `@phosphor-icons/react`, `@tabler/icons-react`, `@iconify/react` |
| charts | `recharts`, `chart.js`, `react-chartjs-2`, `@nivo/core`, `victory`, `@visx/visx`, `d3`, `apexcharts`, `react-apexcharts`, `tremor` |
| tables | `@tanstack/react-table`, `ag-grid-react`, `@ag-grid-community/react`, `react-data-grid` |
| date_picker | `react-datepicker`, `react-day-picker`, `@mui/x-date-pickers`, `@mantine/dates` |
| carousel | `swiper`, `embla-carousel-react`, `keen-slider`, `react-slick`, `splide`, `@splidejs/react-splide` |
| toast_notification | `react-hot-toast`, `react-toastify`, `sonner`, `@radix-ui/react-toast`, `notistack` |
| modal_dialog | `@radix-ui/react-dialog`, `@headlessui/react`, `react-modal`, `@mui/material` |
| maps | `react-map-gl`, `@react-google-maps/api`, `leaflet`, `react-leaflet`, `mapbox-gl`, `@vis.gl/react-google-maps` |
| rich_text | `tiptap`, `@tiptap/react`, `slate`, `slate-react`, `draft-js`, `react-quill`, `@lexical/react` |
| drag_and_drop | `@dnd-kit/core`, `react-beautiful-dnd`, `@hello-pangea/dnd`, `react-dnd` |
| testing | `vitest`, `jest`, `@testing-library/react`, `cypress`, `playwright` |
| css_in_js | `styled-components`, `@emotion/styled`, `@emotion/css`, `@stitches/react`, `vanilla-extract` |
| component_library | `@mui/material`, `@mantine/core`, `@chakra-ui/react`, `@radix-ui/themes`, `@nextui-org/react`, `antd`, `@shadcn/ui` |
| internationalization | `next-intl`, `react-i18next`, `i18next`, `react-intl`, `@formatjs/intl` |
| auth | `next-auth`, `@auth/core`, `@clerk/nextjs`, `@supabase/auth-helpers-nextjs`, `firebase/auth` |
| vue_data_fetching | `@tanstack/vue-query`, `ofetch` |
| vue_state | `pinia`, `vuex` |
| vue_forms | `vee-validate`, `formkit`, `@tanstack/vue-form` |
| vue_icons | `lucide-vue-next`, `@iconify/vue`, `unplugin-icons` |
| vue_components | `vuetify`, `quasar`, `primevue`, `element-plus`, `naive-ui`, `radix-vue`, `shadcn-vue` |
| vue_composables | `@vueuse/core` |
| svelte_data_fetching | `@tanstack/svelte-query` |
| svelte_forms | `superforms`, `felte`, `@tanstack/svelte-form` |
| svelte_icons | `lucide-svelte`, `@steeze-ui/icons` |
| svelte_components | `shadcn-svelte`, `skeleton`, `bits-ui`, `melt-ui`, `flowbite-svelte` |
| angular_state | `@ngrx/store`, `@ngrx/signals`, `@ngxs/store` |
| angular_forms | `ngx-formly` |
| angular_icons | `@ng-icons/core`, `angular-fontawesome` |
| angular_components | `@angular/material`, `primeng`, `ng-zorro-antd`, `taiga-ui`, `spartan-ng` |
| angular_charts | `ngx-charts`, `ng2-charts`, `ngx-echarts` |
| solid_data_fetching | `@tanstack/solid-query` |
| solid_forms | `@modular-forms/solid`, `@felte/solid` |
| solid_components | `kobalte`, `ark-ui/solid`, `corvu` |

**IMPORTANT: This list is a starting reference.** If you encounter an installed package that is NOT in this list but clearly belongs to a capability category (e.g., a new charting library, a new form library), create a new category or add it to the appropriate existing one. The goal is to catch ALL competing libraries, not just the ones listed above. Use the package name and its npm description to determine its category. For framework-specific categories (prefixed with vue_, svelte_, angular_, solid_), only include them if the detected framework matches.
