import {
  CallSender,
  PenpalError,
  AsyncMethodReturns,
  Connection,
  Methods,
} from '../types';
import { ErrorCode, MessageType, NativeEventType } from '../enums';

import createDestructor from '../createDestructor';
import createLogger from '../createLogger';
import getOriginFromSrc from './getOriginFromSrc';
import handleAckMessageFactory from './handleAckMessageFactory';
import handleSynMessageFactory from './handleSynMessageFactory';
import { serializeMethods } from '../methodSerialization';
import monitorIframeRemoval from './monitorIframeRemoval';
import startConnectionTimeout from '../startConnectionTimeout';
import validateIframeHasSrcOrSrcDoc from './validateIframeHasSrcOrSrcDoc';

type Options = {
  /**
   * The iframe to which a connection should be made.
   */
  iframe: HTMLIFrameElement;
  /**
   * Methods that may be called by the iframe.
   */
  parentWindow?: Window;
  /**
   * The parent window of the iframe that will be receiving messages.
   * Used for setting the connection event listener when the current window
   * is not the same as the iframe's parent window.
   */
  methods?: Methods;
  /**
   * The child origin to use to secure communication. If
   * not provided, the child origin will be derived from the
   * iframe's src or srcdoc value.
   */
  childOrigin?: string;
  /**
   * The amount of time, in milliseconds, Penpal should wait
   * for the iframe to respond before rejecting the connection promise.
   */
  timeout?: number;
  /**
   * Whether log messages should be emitted to the console.
   */
  debug?: boolean;
};

/**
 * Attempts to establish communication with an iframe.
 */
export default <TCallSender extends object = CallSender>(
  options: Options
): Connection<TCallSender> => {
  let {
    iframe,
    parentWindow = window,
    methods = {},
    childOrigin,
    timeout,
    debug = false,
  } = options;

  const log = createLogger(debug);
  const destructor = createDestructor('Parent', log);
  const { onDestroy, destroy } = destructor;

  if (!childOrigin) {
    validateIframeHasSrcOrSrcDoc(iframe);
    childOrigin = getOriginFromSrc(iframe.src);
  }

  // If event.origin is "null", the remote protocol is file: or data: and we
  // must post messages with "*" as targetOrigin when sending messages.
  // https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#Using_window.postMessage_in_extensions
  const originForSending = childOrigin === 'null' ? '*' : childOrigin;
  const serializedMethods = serializeMethods(methods);
  const handleSynMessage = handleSynMessageFactory(
    log,
    serializedMethods,
    childOrigin,
    originForSending
  );
  const handleAckMessage = handleAckMessageFactory(
    parentWindow,
    serializedMethods,
    childOrigin,
    originForSending,
    destructor,
    log
  );

  const promise: Promise<AsyncMethodReturns<TCallSender>> = new Promise(
    (resolve, reject) => {
      const stopConnectionTimeout = startConnectionTimeout(timeout, destroy);
      const handleMessage = (event: MessageEvent) => {
        if (!event.data) {
          return;
        }

        if (event.data.penpal === MessageType.Syn) {
          handleSynMessage(event);
          return;
        }

        if (event.data.penpal === MessageType.Ack) {
          const callSender = handleAckMessage(event) as AsyncMethodReturns<
            TCallSender
          >;

          if (callSender) {
            stopConnectionTimeout();
            resolve(callSender);
          }
          return;
        }
      };

      parentWindow.addEventListener(NativeEventType.Message, handleMessage);

      log('Parent: Awaiting handshake');
      monitorIframeRemoval(iframe, destructor);

      onDestroy((error?: PenpalError) => {
        parentWindow.removeEventListener(
          NativeEventType.Message,
          handleMessage
        );

        if (error) {
          reject(error);
        }
      });
    }
  );

  return {
    promise,
    destroy() {
      // Don't allow consumer to pass an error into destroy.
      destroy();
    },
  };
};
