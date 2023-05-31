import { Constants } from '../constants';
import { handleQuote } from '../helpers/quote';
import { formatNumber, sanitizeText } from '../helpers/utils';
import { Strings } from '../strings';
import { getAuthorText } from '../helpers/author';
import { statusAPI } from '../api/status';
import { renderPhoto } from '../render/photo';
import { renderVideo } from '../render/video';

export const returnError = (error: string): StatusResponse => {
  return {
    text: Strings.BASE_HTML.format({
      lang: '',
      headers: [
        `<meta property="og:title" content="${Constants.BRANDING_NAME}"/>`,
        `<meta property="og:description" content="${error}"/>`
      ].join('')
    })
  };
};

/* Handler for Twitter statuses (Tweets).
   Like Twitter, we use the terminologies interchangably. */
export const handleStatus = async (
  status: string,
  mediaNumber?: number,
  userAgent?: string,
  flags?: InputFlags,
  language?: string,
  event?: FetchEvent
  // eslint-disable-next-line sonarjs/cognitive-complexity
): Promise<StatusResponse> => {
  console.log('Direct?', flags?.direct);

  const api = await statusAPI(status, language, event as FetchEvent, flags);
  const tweet = api?.tweet as APITweet;

  /* Catch this request if it's an API response */
  if (flags?.api) {
    return {
      response: new Response(JSON.stringify(api), {
        headers: { ...Constants.RESPONSE_HEADERS, ...Constants.API_RESPONSE_HEADERS },
        status: api.code
      })
    };
  }

  let overrideMedia: APIMedia | undefined;

  // Check if mediaNumber exists, and if that media exists in tweet.media.all. If it does, we'll store overrideMedia variable
  if (mediaNumber && tweet.media && tweet.media.all && tweet.media.all[mediaNumber - 1]) {
    overrideMedia = tweet.media.all[mediaNumber - 1];
  }

  /* If there was any errors fetching the Tweet, we'll return it */
  switch (api.code) {
    case 401:
      return returnError(Strings.ERROR_PRIVATE);
    case 404:
      return returnError(Strings.ERROR_TWEET_NOT_FOUND);
    case 500:
      return returnError(Strings.ERROR_API_FAIL);
  }

  /* Catch direct media request (d.fxtwitter.com, or .mp4 / .jpg) */
  if (flags?.direct && tweet.media) {
    let redirectUrl: string | null = null;
    const all = tweet.media.all || [];
    // if (tweet.media.videos) {
    //   const { videos } = tweet.media;
    //   redirectUrl = (videos[(mediaNumber || 1) - 1] || videos[0]).url;
    // } else if (tweet.media.photos) {
    //   const { photos } = tweet.media;
    //   redirectUrl = (photos[(mediaNumber || 1) - 1] || photos[0]).url;
    // }

    const selectedMedia = all[(mediaNumber || 1) - 1];
    if (selectedMedia) {
      redirectUrl = selectedMedia.url;
    } else if (all.length > 0) {
      redirectUrl = all[0].url;
    }

    if (redirectUrl) {
      return { response: Response.redirect(redirectUrl, 302) };
    }
  }

  /* Use quote media if there is no media in this Tweet */
  if (!tweet.media && tweet.quote?.media) {
    tweet.media = tweet.quote.media;
    tweet.twitter_card = tweet.quote.twitter_card;
  }

  if (flags?.textOnly) {
    tweet.media = undefined;
  }

  /* At this point, we know we're going to have to create a
     regular embed because it's not an API or direct media request */

  let authorText = getAuthorText(tweet) || Strings.DEFAULT_AUTHOR_TEXT;
  const engagementText = authorText.replace(/ {4}/g, ' ');
  let siteName = Constants.BRANDING_NAME;
  let newText = tweet.text;
  let cacheControl: string | null = null;

  /* Base headers included in all responses */
  const headers = [
    `<link rel="canonical" href="https://twitter.com/${tweet.author.screen_name}/status/${tweet.id}"/>`,
    `<meta property="theme-color" content="${tweet.color}"/>`,
    `<meta property="twitter:card" content="${tweet.twitter_card}"/>`,
    `<meta property="twitter:site" content="@${tweet.author.screen_name}"/>`,
    `<meta property="twitter:creator" content="@${tweet.author.screen_name}"/>`,
    `<meta property="twitter:title" content="${tweet.author.name} (@${tweet.author.screen_name})"/>`
  ];

  /* This little thing ensures if by some miracle a FixTweet embed is loaded in a browser,
     it will gracefully redirect to the destination instead of just seeing a blank screen.

     Telegram is dumb and it just gets stuck if this is included, so we never include it for Telegram UAs. */
  if (userAgent?.indexOf('Telegram') === -1) {
    headers.push(
      `<meta http-equiv="refresh" content="0;url=https://twitter.com/${tweet.author.screen_name}/status/${tweet.id}"/>`
    );
  }

  /* This Tweet has a translation attached to it, so we'll render it. */
  if (tweet.translation) {
    const { translation } = tweet;

    const formatText =
      language === 'en'
        ? Strings.TRANSLATE_TEXT.format({
            language: translation.source_lang_en
          })
        : Strings.TRANSLATE_TEXT_INTL.format({
            source: translation.source_lang.toUpperCase(),
            destination: translation.target_lang.toUpperCase()
          });

    newText = `${formatText}\n\n` + `${translation.text}\n\n`;
  }

  console.log('overrideMedia', JSON.stringify(overrideMedia));

  if (overrideMedia) {
    let instructions: ResponseInstructions;

    switch (overrideMedia.type) {
      case 'photo':
        /* This Tweet has a photo to render. */
        instructions = renderPhoto(
          {
            tweet: tweet,
            authorText: authorText,
            engagementText: engagementText,
            userAgent: userAgent,
            isOverrideMedia: true
          },
          overrideMedia as APIPhoto
        );
        headers.push(...instructions.addHeaders);
        if (instructions.authorText) {
          authorText = instructions.authorText;
        }
        if (instructions.siteName) {
          siteName = instructions.siteName;
        }
        break;
      case 'video':
        instructions = renderVideo(
          { tweet: tweet, userAgent: userAgent, text: newText, isOverrideMedia: true },
          overrideMedia as APIVideo
        );
        headers.push(...instructions.addHeaders);
        if (instructions.authorText) {
          authorText = instructions.authorText;
        }
        if (instructions.siteName) {
          siteName = instructions.siteName;
        }
        /* This Tweet has a video to render. */
        break;
    }
  } else if (tweet.media?.mosaic) {
    const instructions = renderPhoto(
      {
        tweet: tweet,
        authorText: authorText,
        engagementText: engagementText,
        userAgent: userAgent
      },
      tweet.media?.mosaic
    );
    headers.push(...instructions.addHeaders);
  } else if (tweet.media?.videos) {
    const instructions = renderVideo(
      { tweet: tweet, userAgent: userAgent, text: newText },
      tweet.media?.videos[0]
    );
    headers.push(...instructions.addHeaders);
    if (instructions.authorText) {
      authorText = instructions.authorText;
    }
    if (instructions.siteName) {
      siteName = instructions.siteName;
    }
  } else if (tweet.media?.photos) {
    const instructions = renderPhoto(
      {
        tweet: tweet,
        authorText: authorText,
        engagementText: engagementText,
        userAgent: userAgent
      },
      tweet.media?.photos[0]
    );
    headers.push(...instructions.addHeaders);
  } else if (tweet.media?.external) {
    const { external } = tweet.media;
    authorText = newText || '';
    headers.push(
      `<meta property="twitter:player" content="${external.url}">`,
      `<meta property="twitter:player:width" content="${external.width}">`,
      `<meta property="twitter:player:height" content="${external.height}">`,
      `<meta property="og:type" content="video.other">`,
      `<meta property="og:video:url" content="${external.url}">`,
      `<meta property="og:video:secure_url" content="${external.url}">`,
      `<meta property="og:video:width" content="${external.width}">`,
      `<meta property="og:video:height" content="${external.height}">`
    );
  }

  /* This Tweet contains a poll, so we'll render it */
  if (tweet.poll) {
    const { poll } = tweet;
    let barLength = 32;
    let str = '';

    /* Telegram Embeds are smaller, so we use a smaller bar to compensate */
    if (userAgent?.indexOf('Telegram') !== -1) {
      barLength = 24;
    }

    /* Render each poll choice */
    tweet.poll.choices.forEach(choice => {
      const bar = '█'.repeat((choice.percentage / 100) * barLength);
      // eslint-disable-next-line no-irregular-whitespace
      str += `${bar}\n${choice.label}  (${choice.percentage}%)\n`;
    });

    /* Finally, add the footer of the poll with # of votes and time left */
    str += `\n${formatNumber(poll.total_votes)} votes · ${poll.time_left_en}`;

    /* Check if the poll is ongoing and apply low TTL cache control.
       Yes, checking if this is a string is a hacky way to do this, but
       it can do it in way less code than actually comparing dates */
    if (poll.time_left_en !== 'Final results') {
      cacheControl = Constants.POLL_TWEET_CACHE;
    }

    /* And now we'll put the poll right after the Tweet text! */
    newText += `\n\n${str}`;
  }

  /* This Tweet quotes another Tweet, so we'll render the other Tweet where possible */
  if (api.tweet?.quote) {
    const quoteText = handleQuote(api.tweet.quote);
    newText += `\n${quoteText}`;
  }

  /* If we have no media to display, instead we'll display the user profile picture in the embed */
  if (!tweet.media?.videos && !tweet.media?.photos && !flags?.textOnly) {
    headers.push(
      /* Use a slightly higher resolution image for profile pics */
      `<meta property="og:image" content="${tweet.author.avatar_url?.replace(
        '_normal',
        '_200x200'
      )}"/>`,
      `<meta property="twitter:image" content="0"/>`
    );
  }

  /* Notice that user is using deprecated domain */
  if (flags?.deprecated) {
    siteName = Strings.DEPRECATED_DOMAIN_NOTICE;
  }

  /* Push basic headers relating to author, Tweet text, and site name */
  headers.push(
    `<meta property="og:title" content="${tweet.author.name} (@${tweet.author.screen_name})"/>`,
    `<meta property="og:description" content="${sanitizeText(newText)}"/>`,
    `<meta property="og:site_name" content="${siteName}"/>`
  );

  /* Special reply handling if authorText is not overriden */
  if (tweet.replying_to && authorText === Strings.DEFAULT_AUTHOR_TEXT) {
    authorText = `↪ Replying to @${tweet.replying_to}`;
    /* We'll assume it's a thread if it's a reply to themselves */
  } else if (
    tweet.replying_to === tweet.author.screen_name &&
    authorText === Strings.DEFAULT_AUTHOR_TEXT
  ) {
    authorText = `↪ A part of @${tweet.author.screen_name}'s thread`;
  }

  /* The additional oembed is pulled by Discord to enable improved embeds.
     Telegram does not use this. */
  headers.push(
    `<link rel="alternate" href="${Constants.HOST_URL}/owoembed?text=${encodeURIComponent(
      authorText.substring(0, 200)
    )}${flags?.deprecated ? '&deprecated=true' : ''}&status=${encodeURIComponent(
      status
    )}&author=${encodeURIComponent(
      tweet.author?.screen_name || ''
    )}" type="application/json+oembed" title="${tweet.author.name}">`
  );

  /* When dealing with a Tweet of unknown lang, fall back to en */
  const lang = tweet.lang === null ? 'en' : tweet.lang || 'en';

  /* Finally, after all that work we return the response HTML! */
  return {
    text: Strings.BASE_HTML.format({
      lang: `lang="${lang}"`,
      headers: headers.join('')
    }),
    cacheControl: cacheControl
  };
};