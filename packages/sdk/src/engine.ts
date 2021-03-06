import { cloneDeep } from "lodash";
import { BasicAddonClass } from "./addons";
import { CacheFoundError, CacheHandler, getCacheEngineFromEnv } from "./cache";
import { migrations } from "./migrations";
import {
  createTaskFetch,
  createTaskNotification,
  createTaskRecaptcha,
  createTaskToast,
  handleTask,
  Responder,
} from "./tasks";
import {
  ActionHandlerContext,
  AddonHandlerFn,
  Engine,
  EngineOptions,
} from "./types";
import { RecordData, RequestRecorder } from "./utils/request-recorder";
import { validateSignature } from "./utils/signature";
import { getActionValidator } from "./validators";

const defaultOptions = {
  requestRecorderPath: null,
  replayMode: false,
};

/**
 * Handle options and prepare addons
 */
export const createEngine = (
  addons: BasicAddonClass[],
  options?: Partial<EngineOptions>
): Engine => {
  for (const addon of addons) {
    try {
      addon.validateAddon();
    } catch (error) {
      throw new Error(
        `Validation of addon "${addon.getId()}" failed: ${error.message}`
      );
    }
  }

  const opts: EngineOptions = {
    ...defaultOptions,
    ...options,
    cache: options?.cache ?? new CacheHandler(getCacheEngineFromEnv()),
    middlewares: options?.middlewares ?? {},
  };

  let frozen = false;
  let requestRecorder: null | RequestRecorder = null;

  const assertNotFrozen = () => {
    if (frozen) {
      throw new Error(
        "Not allowed to update options after addon handlers are created"
      );
    }
  };

  const initialize = () => {
    assertNotFrozen();

    console.info(`Using cache: ${opts.cache.engine.constructor.name}`);

    if (opts.requestRecorderPath) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "Request recording is not supported in production builds"
        );
      }
      requestRecorder = new RequestRecorder(opts.requestRecorderPath);
      console.warn(`Logging requests to ${requestRecorder.path}`);
    }

    frozen = true;
  };

  return {
    addons,
    updateOptions: (o: Partial<EngineOptions>) => {
      assertNotFrozen();
      Object.assign(opts, o);
    },
    initialize,
    createAddonHandler: (addon: BasicAddonClass) => {
      if (!frozen) initialize();
      return createAddonHandler(addon, opts, requestRecorder);
    },
  };
};

const createAddonHandler = (
  addon: BasicAddonClass,
  options: EngineOptions,
  requestRecorder: null | RequestRecorder
): AddonHandlerFn => async ({ action, input, sig, request, sendResponse }) => {
  // Store input data for recording
  const originalInput = requestRecorder ? cloneDeep(input) : null;

  // Run event handlers
  if (options.middlewares.init) {
    for (const fn of options.middlewares.init) {
      input = await fn(addon, action, input);
    }
  }

  // Handle task responses
  if (action === "task") {
    await handleTask({
      cache: options.cache,
      addon,
      input,
      sendResponse,
    });
    return;
  }

  // Get action handler before verifying the signature
  const handler = addon.getActionHandler(action);

  // Check if we are running in test mode
  const testMode = options.replayMode || action === "selftest";

  // Validate the signature
  let user: ActionHandlerContext["user"];
  try {
    user =
      testMode ||
      process.env.SKIP_AUTH === "1" ||
      action === "addon" ||
      (addon.getType() === "repository" && action === "repository")
        ? null
        : validateSignature(sig);
  } catch (error) {
    sendResponse(403, { error: error.message || error });
    return;
  }

  // Migration and input validation
  const migrationContext = {
    addon,
    data: {},
    user,
    validator: getActionValidator(addon.getType(), action),
  };
  try {
    if (migrations[action]?.request) {
      input = migrations[action].request(migrationContext, input);
    } else {
      input = migrationContext.validator.request(input);
    }
  } catch (error) {
    sendResponse(400, { error: error.message || error });
    return;
  }

  // Get a cache handler instance
  const cache = options.cache.clone({
    prefix: addon.getId(),
    ...addon.getDefaultCacheOptions(),
  });

  // Request cache instance
  let inlineCache: any = null;

  // Responder object
  const responder = new Responder(sendResponse);

  // Action handler context
  const ctx: ActionHandlerContext = {
    cache,
    request,
    user,
    requestCache: async (key, options) => {
      if (inlineCache) throw new Error(`Request cache is already set up`);
      const c = cache.clone(options);
      inlineCache = await c.inline(key);
    },
    fetch: createTaskFetch(testMode, responder, cache),
    recaptcha: createTaskRecaptcha(testMode, responder, cache),
    toast: createTaskToast(testMode, responder, cache),
    notification: createTaskNotification(testMode, responder, cache),
  };

  // Run event handlers
  if (options.middlewares.request) {
    for (const fn of options.middlewares.request) {
      input = await fn(addon, action, ctx, input);
    }
  }

  // Handle the request
  let statusCode = 200;
  let output: any;
  try {
    output = await handler(input, ctx, addon);

    // Raise default errors
    switch (action) {
      case "resolve":
      case "captcha":
        if (output === null) throw new Error("Nothing found");
        break;
    }

    // Apply migrations
    if (migrations[action]?.response) {
      output = migrations[action].response(migrationContext, input, output);
    } else {
      output = migrationContext.validator.response(output);
    }

    // Handle the requestCache
    if (inlineCache) await inlineCache.set(output);
  } catch (error) {
    // Check if request cache had a hit
    if (error instanceof CacheFoundError) {
      if (error.result !== undefined) {
        output = error.result;
      } else {
        statusCode = 500;
        output = { error: error.error };
      }
    } else {
      // Handle the requestCache
      if (inlineCache) await inlineCache.setError(error);

      // Set the error
      statusCode = 500;
      output = { error: error.message || error };
      if (!error.noBacktraceLog) console.warn(error);
    }
  }

  // Run event handlers
  if (options.middlewares.response) {
    for (const fn of options.middlewares.response) {
      output = await fn(addon, action, ctx, input, output);
    }
  }

  // Record
  if (requestRecorder) {
    const record: Partial<RecordData> = {
      addon: addon.getId(),
      action: action,
      input: originalInput,
      output: output,
      statusCode: statusCode,
    };
    await requestRecorder.write(<RecordData>record);
  }

  // Send the response
  const id = await responder.send(statusCode, output);
  responder.setSendResponse(id, null);
};
