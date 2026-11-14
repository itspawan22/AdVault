/* Shapes mirror real Ad Library GraphQL nodes observed on facebook.com/ads/library (Nov 2026). */
export const cdn = (name: string, host = 'scontent.fixc1-3.fna.fbcdn.net') =>
  `https://${host}/v/t39.35426-6/${name}?stp=dst-jpg&_nc_cat=101&oh=00_sig${Math.random().toString(36).slice(2)}&oe=6AF891D2`;
export const vcdn = (name: string) =>
  `https://video.fixc1-4.fna.fbcdn.net/o1/v/t2/f2/m366/${name}.mp4?_nc_cat=101&oh=00_sig${Math.random().toString(36).slice(2)}`;

export function videoAd(id: string, start: number, extra: Record<string, unknown> = {}) {
  return {
    ad_archive_id: id,
    collation_count: 1,
    collation_id: '1105654985611944',
    is_active: true,
    page_id: '778794852137593',
    page_name: 'Allbirds',
    snapshot: {
      page_id: '778794852137593',
      page_name: 'Allbirds',
      creation_time: 1600000000,
      cards: [],
      body: { text: 'Super fuzzy on the inside, lightweight, and sharp.' },
      display_format: 'VIDEO',
      link_url: 'https://www.allbirds.com/products/mens-cruiser-dark-navy',
      images: [],
      title: "Men's Cruiser Dark Navy",
      videos: [
        {
          video_hd_url: vcdn(`HD_${id}`),
          video_preview_image_url: cdn(`poster_${id}_n.jpg`),
          video_sd_url: vcdn(`SD_${id}`),
          watermarked_video_hd_url: null,
          watermarked_video_sd_url: null,
        },
      ],
      extra_images: [],
      extra_videos: [],
    },
    end_date: 1794211200,
    start_date: start,
    ...extra,
  };
}

export function imageAd(id: string, start: number | null, images: string[], extra: Record<string, unknown> = {}) {
  return {
    ad_archive_id: id,
    is_active: true,
    page_id: '778794852137593',
    page_name: 'Allbirds',
    snapshot: {
      page_name: 'Allbirds',
      cards: [],
      body: { text: 'Image ad body' },
      display_format: 'IMAGE',
      images: images.map((n) => ({ original_image_url: cdn(n), resized_image_url: cdn(`resized_${n}`) })),
      title: 'Wool Runner',
      videos: [],
    },
    start_date: start,
    end_date: null,
    ...extra,
  };
}

export function carouselAd(id: string, start: number) {
  return {
    ad_archive_id: id,
    is_active: true,
    page_id: '778794852137593',
    page_name: 'Allbirds',
    snapshot: {
      page_name: 'Allbirds',
      body: { text: '{{product.brand}}' },
      display_format: 'DCO',
      images: [],
      videos: [],
      title: null,
      cards: [
        { body: 'Card one', title: 'Card title', original_image_url: cdn('card1_n.jpg'), resized_image_url: cdn('card1_small_n.jpg') },
        { body: 'Card two', video_hd_url: vcdn('card2'), video_sd_url: vcdn('card2_sd'), video_preview_image_url: cdn('card2_poster_n.jpg'), original_image_url: cdn('card2_poster_n.jpg') },
        { body: 'Card one again', original_image_url: cdn('card1_n.jpg') },
      ],
    },
    start_date: start,
  };
}

export function searchResponse(nodes: unknown[], hasNext: boolean, count = 68) {
  return {
    data: {
      ad_library_main: {
        search_results_connection: {
          count,
          edges: [{ node: { collated_results: nodes, __typename: 'AdArchiveSearchResultGroup' } }],
          page_info: { end_cursor: 'AQHT', has_next_page: hasNext },
        },
      },
    },
  };
}
