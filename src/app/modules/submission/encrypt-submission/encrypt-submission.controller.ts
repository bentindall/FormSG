import JoiDate from '@joi/date'
import { encode as encodeBase64 } from '@stablelib/base64'
import { celebrate, Joi as BaseJoi, Segments } from 'celebrate'
import { AuthedSessionData } from 'express-session'
import { StatusCodes } from 'http-status-codes'
import JSONStream from 'JSONStream'
import { chain, omit } from 'lodash'
import mongoose from 'mongoose'
import { okAsync } from 'neverthrow'
import Stripe from 'stripe'
import type { SetOptional } from 'type-fest'

import {
  ErrorDto,
  FormAuthType,
  FormSubmissionMetadataQueryDto,
  Payment,
  PaymentChannel,
  PaymentType,
  StorageModeAttachment,
  StorageModeAttachmentsMap,
  StorageModeSubmissionContentDto,
  StorageModeSubmissionDto,
  StorageModeSubmissionMetadataList,
  SubmissionErrorDto,
  SubmissionResponseDto,
} from '../../../../../shared/types'
import {
  IPopulatedEncryptedForm,
  StripePaymentMetadataDto,
} from '../../../../types'
import {
  EncryptFormFieldResponse,
  EncryptSubmissionDto,
  ParsedStorageModeSubmissionBody,
} from '../../../../types/api'
import config from '../../../config/config'
import { paymentConfig } from '../../../config/features/payment.config'
import formsgSdk from '../../../config/formsg-sdk'
import { createLoggerWithLabel } from '../../../config/logger'
import { stripe } from '../../../loaders/stripe'
import getPaymentModel from '../../../models/payment.server.model'
import { getEncryptPendingSubmissionModel } from '../../../models/pending_submission.server.model'
import { getEncryptSubmissionModel } from '../../../models/submission.server.model'
import * as CaptchaMiddleware from '../../../services/captcha/captcha.middleware'
import * as TurnstileMiddleware from '../../../services/turnstile/turnstile.middleware'
import { Pipeline } from '../../../utils/pipeline-middleware'
import { createReqMeta } from '../../../utils/request'
import { getFormAfterPermissionChecks } from '../../auth/auth.service'
import { MalformedParametersError } from '../../core/core.errors'
import { ControllerHandler } from '../../core/core.types'
import { setFormTags } from '../../datadog/datadog.utils'
import { PermissionLevel } from '../../form/admin-form/admin-form.types'
import * as FormService from '../../form/form.service'
import { SgidService } from '../../sgid/sgid.service'
import { getOidcService } from '../../spcp/spcp.oidc.service'
import { getPopulatedUserById } from '../../user/user.service'
import * as VerifiedContentService from '../../verified-content/verified-content.service'
import * as EncryptSubmissionMiddleware from '../encrypt-submission/encrypt-submission.middleware'
import * as ReceiverMiddleware from '../receiver/receiver.middleware'
import { getFilteredResponses, isAttachmentResponse } from '../submission.utils'
import { reportSubmissionResponseTime } from '../submissions.statsd-client'

import {
  ensureFormWithinSubmissionLimits,
  ensurePublicForm,
  ensureValidCaptcha,
} from './encrypt-submission.ensures'
import {
  addPaymentDataStream,
  checkFormIsEncryptMode,
  getEncryptedSubmissionData,
  getSubmissionCursor,
  getSubmissionMetadata,
  getSubmissionMetadataList,
  getSubmissionPaymentDto,
  performEncryptPostSubmissionActions,
  transformAttachmentMetasToSignedUrls,
  transformAttachmentMetaStream,
  uploadAttachments,
} from './encrypt-submission.service'
import {
  createEncryptedSubmissionDto,
  getPaymentAmount,
  mapRouteError,
} from './encrypt-submission.utils'
import IncomingEncryptSubmission from './IncomingEncryptSubmission.class'

export const logger = createLoggerWithLabel(module)
const EncryptSubmission = getEncryptSubmissionModel(mongoose)
const EncryptPendingSubmission = getEncryptPendingSubmissionModel(mongoose)
const Payment = getPaymentModel(mongoose)

// NOTE: Refer to this for documentation: https://github.com/sideway/joi-date/blob/master/API.md
const Joi = BaseJoi.extend(JoiDate)

type SubmitEncryptModeFormControllerHandlerType = ControllerHandler<
  { formId: string },
  SubmissionResponseDto | SubmissionErrorDto,
  EncryptSubmissionDto,
  { captchaResponse?: unknown }
>

const submitEncryptModeForm: SubmitEncryptModeFormControllerHandlerType =
  async (req, res) => {
    const { formId } = req.params

    if ('isPreview' in req.body) {
      logger.info({
        message:
          'isPreview is still being sent when submitting encrypt mode form',
        meta: {
          action: 'submitEncryptModeForm',
          type: 'deprecatedCheck',
        },
      })
    }

    const logMeta = {
      action: 'submitEncryptModeForm',
      ...createReqMeta(req),
      formId,
    }

    // Retrieve form
    const formResult = await FormService.retrieveFullFormById(formId)
    if (formResult.isErr()) {
      logger.warn({
        message: 'Failed to retrieve form from database',
        meta: logMeta,
        error: formResult.error,
      })
      const { errorMessage, statusCode } = mapRouteError(formResult.error)
      return res.status(statusCode).json({ message: errorMessage })
    }

    setFormTags(formResult.value)

    const checkFormIsEncryptModeResult = checkFormIsEncryptMode(
      formResult.value,
    )
    if (checkFormIsEncryptModeResult.isErr()) {
      logger.error({
        message:
          'Trying to submit non-encrypt mode submission on encrypt-form submission endpoint',
        meta: logMeta,
      })
      const { statusCode, errorMessage } = mapRouteError(
        checkFormIsEncryptModeResult.error,
      )
      return res.status(statusCode).json({
        message: errorMessage,
      })
    }
    const form = checkFormIsEncryptModeResult.value

    const ensurePipeline = new Pipeline(
      ensurePublicForm,
      ensureValidCaptcha,
      ensureFormWithinSubmissionLimits,
    )

    const hasEnsuredAll = await ensurePipeline.execute({
      form,
      logMeta,
      req,
      res,
    })

    if (!hasEnsuredAll) {
      return
    }

    // Create Incoming Submission
    const { encryptedContent, responses, responseMetadata, paymentProducts } =
      req.body
    const incomingSubmissionResult = IncomingEncryptSubmission.init(
      form,
      responses,
      encryptedContent,
    )
    if (incomingSubmissionResult.isErr()) {
      const { statusCode, errorMessage } = mapRouteError(
        incomingSubmissionResult.error,
      )
      return res.status(statusCode).json({
        message: errorMessage,
      })
    }
    const incomingSubmission = incomingSubmissionResult.value

    delete (req.body as SetOptional<EncryptSubmissionDto, 'responses'>)
      .responses

    // Checks if user is SPCP-authenticated before allowing submission
    let uinFin
    let userInfo
    const { authType } = form
    switch (authType) {
      case FormAuthType.MyInfo: {
        logger.error({
          message:
            'Storage mode form is not allowed to have MyInfo authorisation',
          meta: logMeta,
        })
        const { errorMessage, statusCode } = mapRouteError(
          new MalformedParametersError(
            'Storage mode form is not allowed to have MyInfo authType',
          ),
        )
        return res.status(statusCode).json({ message: errorMessage })
      }
      case FormAuthType.SP: {
        const oidcService = getOidcService(FormAuthType.SP)
        const jwtPayloadResult = await oidcService
          .extractJwt(req.cookies)
          .asyncAndThen((jwt) => oidcService.extractJwtPayload(jwt))
        if (jwtPayloadResult.isErr()) {
          const { statusCode, errorMessage } = mapRouteError(
            jwtPayloadResult.error,
          )
          logger.error({
            message: 'Failed to verify Singpass JWT with auth client',
            meta: logMeta,
            error: jwtPayloadResult.error,
          })
          return res.status(statusCode).json({
            message: errorMessage,
            spcpSubmissionFailure: true,
          })
        }
        uinFin = jwtPayloadResult.value.userName
        break
      }
      case FormAuthType.CP: {
        const oidcService = getOidcService(FormAuthType.CP)
        const jwtPayloadResult = await oidcService
          .extractJwt(req.cookies)
          .asyncAndThen((jwt) => oidcService.extractJwtPayload(jwt))
        if (jwtPayloadResult.isErr()) {
          const { statusCode, errorMessage } = mapRouteError(
            jwtPayloadResult.error,
          )
          logger.error({
            message: 'Failed to verify Corppass JWT with auth client',
            meta: logMeta,
            error: jwtPayloadResult.error,
          })
          return res.status(statusCode).json({
            message: errorMessage,
            spcpSubmissionFailure: true,
          })
        }
        uinFin = jwtPayloadResult.value.userName
        userInfo = jwtPayloadResult.value.userInfo
        break
      }
      case FormAuthType.SGID: {
        const jwtPayloadResult = SgidService.extractSgidSingpassJwtPayload(
          req.cookies.jwtSgid,
        )
        if (jwtPayloadResult.isErr()) {
          const { statusCode, errorMessage } = mapRouteError(
            jwtPayloadResult.error,
          )
          logger.error({
            message: 'Failed to verify sgID JWT with auth client',
            meta: logMeta,
            error: jwtPayloadResult.error,
          })
          return res.status(statusCode).json({
            message: errorMessage,
            spcpSubmissionFailure: true,
          })
        }
        uinFin = jwtPayloadResult.value.userName
        break
      }
    }

    // Encrypt Verified SPCP Fields
    let verified
    if (
      form.authType === FormAuthType.SP ||
      form.authType === FormAuthType.CP ||
      form.authType === FormAuthType.SGID
    ) {
      const encryptVerifiedContentResult =
        VerifiedContentService.getVerifiedContent({
          type: form.authType,
          data: { uinFin, userInfo },
        }).andThen((verifiedContent) =>
          VerifiedContentService.encryptVerifiedContent({
            verifiedContent,
            formPublicKey: form.publicKey,
          }),
        )

      if (encryptVerifiedContentResult.isErr()) {
        const { error } = encryptVerifiedContentResult
        logger.error({
          message: 'Unable to encrypt verified content',
          meta: logMeta,
          error,
        })

        return res
          .status(StatusCodes.BAD_REQUEST)
          .json({ message: 'Invalid data was found. Please submit again.' })
      } else {
        // No errors, set local variable to the encrypted string.
        verified = encryptVerifiedContentResult.value
      }
    }

    // Save Responses to Database
    let attachmentMetadata = new Map<string, string>()

    if (req.body.attachments) {
      const attachmentUploadResult = await uploadAttachments(
        form._id,
        req.body.attachments,
      )

      if (attachmentUploadResult.isErr()) {
        const { statusCode, errorMessage } = mapRouteError(
          attachmentUploadResult.error,
        )
        return res.status(statusCode).json({
          message: errorMessage,
        })
      } else {
        attachmentMetadata = attachmentUploadResult.value
      }
    }

    const submissionContent = {
      form: form._id,
      authType: form.authType,
      myInfoFields: form.getUniqueMyInfoAttrs(),
      encryptedContent: incomingSubmission.encryptedContent,
      verifiedContent: verified,
      attachmentMetadata,
      version: req.body.version,
      responseMetadata,
    }

    // Handle submissions for payments forms
    if (
      form.payments_field?.enabled &&
      form.payments_channel.channel === PaymentChannel.Stripe
    ) {
      return _createPaymentSubmission({
        req,
        res,
        form,
        logMeta,
        formId,
        incomingSubmission,
        paymentProducts,
        responseMetadata,
        submissionContent,
      })
    }

    return _createSubmission({
      req,
      res,
      logMeta,
      formId,
      incomingSubmission,
      responseMetadata,
      submissionContent,
    })
  }

const _createPaymentSubmission = async ({
  req,
  res,
  form,
  logMeta,
  formId,
  incomingSubmission,
  submissionContent,
  responseMetadata,
  paymentProducts,
}: {
  req: Parameters<SubmitEncryptModeFormControllerHandlerType>[0]
  res: Parameters<SubmitEncryptModeFormControllerHandlerType>[1]
  form: IPopulatedEncryptedForm
  paymentProducts: StorageModeSubmissionContentDto['paymentProducts']
  [others: string]: any
}) => {
  const amount = getPaymentAmount(
    form.payments_field,
    req.body.payments,
    paymentProducts,
  )

  const isPaymentTypeProducts =
    form.payments_field.payment_type === PaymentType.Products

  logger.info({
    message: 'Incoming payments',
    meta: {
      ...logMeta,
      paymentProducts,
      paymentType: form.payments_field.payment_type,
      amount,
    },
  })

  // Step 0: Perform validation checks
  if (
    !amount ||
    amount < paymentConfig.minPaymentAmountCents ||
    amount > paymentConfig.maxPaymentAmountCents
  ) {
    logger.error({
      message: 'Error when creating payment: amount is not within bounds',
      meta: logMeta,
    })
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message:
        "The form's payment settings are invalid. Please contact the admin of the form to rectify the issue.",
    })
  }
  const paymentReceiptEmail = req.body.paymentReceiptEmail?.toLowerCase()
  if (!paymentReceiptEmail) {
    logger.error({
      message:
        'Error when creating payment: payment receipt email not provided.',
      meta: logMeta,
    })
    return res.status(StatusCodes.BAD_REQUEST).json({
      message:
        "The form's payment settings are invalid. Please contact the admin of the form to rectify the issue.",
    })
  }

  const targetAccountId = form.payments_channel.target_account_id

  // Step 1: Create payment without payment intent id and pending submission id.
  const payment = new Payment({
    formId,
    targetAccountId,
    amount,
    email: paymentReceiptEmail,
    responses: incomingSubmission.responses,
    ...(isPaymentTypeProducts ? { products: paymentProducts } : {}),
    gstEnabled: form.payments_field.gst_enabled,
    payment_fields_snapshot: form.payments_field,
  })
  const paymentId = payment.id

  // Step 2: Create and save pending submission.
  const pendingSubmission = new EncryptPendingSubmission({
    ...submissionContent,
    paymentId,
  })

  try {
    await pendingSubmission.save()
  } catch (err) {
    logger.error({
      message: 'Encrypt pending submission save error',
      meta: {
        action: 'onEncryptSubmissionFailure',
        ...createReqMeta(req),
      },
      error: err,
    })
    // Block the submission so that user can try to resubmit
    return res.status(StatusCodes.BAD_REQUEST).json({
      message:
        'Could not save pending submission. For assistance, please contact the person who asked you to fill in this form.',
    })
  }

  const pendingSubmissionId = pendingSubmission.id
  logger.info({
    message: 'Created pending submission in DB',
    meta: {
      ...logMeta,
      pendingSubmissionId,
      responseMetadata,
    },
  })

  // Step 3: Create the payment intent via API call to stripe.
  // Stripe requires the amount to be an integer in the smallest currency unit (i.e. cents)
  const metadata: StripePaymentMetadataDto = {
    env: config.envSiteName,
    formTitle: form.title,
    formId,
    submissionId: pendingSubmissionId,
    paymentId,
    paymentContactEmail: paymentReceiptEmail,
  }

  const createPaymentIntentParams: Stripe.PaymentIntentCreateParams = {
    amount,
    currency: paymentConfig.defaultCurrency,
    // determine payment methods available based on stripe settings
    automatic_payment_methods: {
      enabled: true,
    },
    description: form.payments_field.description,
    receipt_email: paymentReceiptEmail,
    metadata,
  }

  let paymentIntent
  try {
    paymentIntent = await stripe.paymentIntents.create(
      createPaymentIntentParams,
      { stripeAccount: targetAccountId },
    )
  } catch (err) {
    logger.error({
      message: 'Error when creating payment intent',
      meta: {
        ...logMeta,
        pendingSubmissionId,
        createPaymentIntentParams,
      },
      error: err,
    })
    // Return a 502 error here since the issue was with Stripe.
    return res.status(StatusCodes.BAD_GATEWAY).json({
      message:
        'There was a problem creating the payment intent. Please try again.',
    })
  }

  const paymentIntentId = paymentIntent.id
  logger.info({
    message: 'Created payment intent from Stripe',
    meta: {
      ...logMeta,
      pendingSubmissionId,
      paymentIntentId,
    },
  })

  // Step 4: Update payment document with payment intent id and pending submission id, and save it.
  payment.paymentIntentId = paymentIntentId
  payment.pendingSubmissionId = pendingSubmissionId
  try {
    await payment.save()
  } catch (err) {
    logger.error({
      message: 'Error updating payment document with payment intent id',
      meta: {
        ...logMeta,
        pendingSubmissionId,
        paymentIntentId,
      },
      error: err,
    })
    // Cancel the payment intent if saving the document fails.
    try {
      await stripe.paymentIntents.cancel(paymentIntent.id, {
        stripeAccount: targetAccountId,
      })
    } catch (stripeErr) {
      logger.error({
        message: 'Failed to cancel Stripe payment intent',
        meta: {
          ...logMeta,
          pendingSubmissionId,
          paymentIntentId,
        },
        error: err,
      })
    }
    // Regardless of whether the cancellation succeeded or failed, block the
    // submission so that user can try to resubmit
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message:
        'There was a problem updating the payment document. Please try again.',
    })
  }

  logger.info({
    message: 'Saved payment document to DB',
    meta: {
      ...logMeta,
      pendingSubmissionId,
      paymentIntentId,
      paymentId,
    },
  })

  return res.json({
    message: 'Form submission successful',
    submissionId: pendingSubmissionId,
    timestamp: (pendingSubmission.created || new Date()).getTime(),
    paymentData: { paymentId },
  })
}

const _createSubmission = async ({
  req,
  res,
  submissionContent,
  logMeta,
  formId,
  responseMetadata,
  incomingSubmission,
}: {
  req: Parameters<SubmitEncryptModeFormControllerHandlerType>[0]
  res: Parameters<SubmitEncryptModeFormControllerHandlerType>[1]
  [others: string]: any
}) => {
  const submission = new EncryptSubmission(submissionContent)

  try {
    await submission.save()
  } catch (err) {
    logger.error({
      message: 'Encrypt submission save error',
      meta: {
        action: 'onEncryptSubmissionFailure',
        ...createReqMeta(req),
      },
      error: err,
    })
    return res.status(StatusCodes.BAD_REQUEST).json({
      message:
        'Could not send submission. For assistance, please contact the person who asked you to fill in this form.',
      submissionId: submission._id,
    })
  }

  const submissionId = submission.id
  logger.info({
    message: 'Saved submission to MongoDB',
    meta: {
      ...logMeta,
      submissionId,
      formId,
      responseMetadata,
    },
  })

  // TODO 6395 make responseMetadata mandatory
  if (responseMetadata) {
    reportSubmissionResponseTime(responseMetadata, {
      mode: 'encrypt',
      payment: 'true',
    })
  }

  // Send success back to client
  res.json({
    message: 'Form submission successful.',
    submissionId,
    timestamp: (submission.created || new Date()).getTime(),
  })

  return await performEncryptPostSubmissionActions(
    submission,
    incomingSubmission.responses,
  )
}

// TODO (FRM-1232): remove endpoint after encryption boundary is shifted
export const handleEncryptedSubmission = [
  CaptchaMiddleware.validateCaptchaParams,
  TurnstileMiddleware.validateTurnstileParams,
  EncryptSubmissionMiddleware.validateEncryptSubmissionParams,
  submitEncryptModeForm,
] as ControllerHandler[]

const encryptAttachment = async (
  attachment: Buffer,
  { id, publicKey }: { id: string; publicKey: string },
): Promise<StorageModeAttachment & { id: string }> => {
  let label

  try {
    label = 'Read file content'

    const fileContentsView = new Uint8Array(attachment)

    label = 'Encrypt content'
    const encryptedAttachment = await formsgSdk.crypto.encryptFile(
      fileContentsView,
      publicKey,
    )

    label = 'Base64-encode encrypted content'
    const encodedEncryptedAttachment = {
      ...encryptedAttachment,
      binary: encodeBase64(encryptedAttachment.binary),
    }

    return { id, encryptedFile: encodedEncryptedAttachment }
  } catch (error) {
    logger.error({
      message: 'Error encrypting attachment',
      meta: {
        action: 'encryptAttachment',
        label,
        error,
      },
    })
    throw error
  }
}

const getEncryptedAttachmentsMapFromAttachmentsMap = async (
  attachmentsMap: Record<string, Buffer>,
  publicKey: string,
): Promise<StorageModeAttachmentsMap> => {
  const attachmentPromises = Object.entries(attachmentsMap).map(
    ([id, attachment]) => encryptAttachment(attachment, { id, publicKey }),
  )

  return Promise.all(attachmentPromises).then((encryptedAttachmentsMeta) =>
    chain(encryptedAttachmentsMeta)
      .keyBy('id')
      // Remove id from object.
      .mapValues((v) => omit(v, 'id'))
      .value(),
  )
}

/**
 * Encrypt submission content before saving to DB.
 */
const encryptSubmission: ControllerHandler<
  { formId: string },
  SubmissionResponseDto | SubmissionErrorDto,
  ParsedStorageModeSubmissionBody
> = async (req, res, next) => {
  const { formId } = req.params

  const logMeta = {
    action: 'convertToEncryptMode',
    ...createReqMeta(req),
    formId,
  }

  // Retrieve form definition. TODO: extract this step when validation is added.
  const formResult = await FormService.retrieveFullFormById(formId)
  if (formResult.isErr()) {
    logger.warn({
      message: 'Failed to retrieve form from database',
      meta: logMeta,
      error: formResult.error,
    })
    const { errorMessage, statusCode } = mapRouteError(formResult.error)
    return res.status(statusCode).json({ message: errorMessage })
  }

  // Guardrail to prevent new endpoint from being used for regular storage mode forms.
  // TODO (FRM-1232): remove this guardrail when encryption boundary is shifted.
  if (!formResult.value.get('newEncryptionBoundary')) {
    return res
      .status(StatusCodes.FORBIDDEN)
      .json({ message: 'This endpoint has not been enabled for this form.' })
  }

  // Retrieve public key.
  const publicKey = formResult.value.publicKey

  if (!publicKey) {
    logger.warn({
      message: 'Form does not have a public key',
      meta: logMeta,
    })
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: 'Form does not have a public key',
    })
  }

  const attachmentsMap: Record<string, Buffer> = {}

  // Populate attachment map
  req.body.responses.filter(isAttachmentResponse).forEach((response) => {
    const fieldId = response._id
    attachmentsMap[fieldId] = response.content
  })

  const encryptedAttachments =
    await getEncryptedAttachmentsMapFromAttachmentsMap(
      attachmentsMap,
      publicKey,
    )

  const filteredResponses = getFilteredResponses(
    formResult.value,
    req.body.responses,
  )

  if (filteredResponses.isErr()) {
    logger.warn({
      message: filteredResponses.error.message,
      meta: logMeta,
    })
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: filteredResponses.error.message,
    })
  }

  const encryptedContent = formsgSdk.crypto.encrypt(
    req.body.responses.map((response) => {
      if (isAttachmentResponse(response)) {
        return {
          ...response,
          filename: undefined,
          content: undefined, //Strip out attachment content
        }
      } else {
        return response
      }
    }),
    publicKey,
  )

  const encryptedVersion = {
    attachments: encryptedAttachments,
    responses: filteredResponses.value as EncryptFormFieldResponse[],
    encryptedContent,
    version: req.body.version,
  }

  req.body = encryptedVersion
  return next()
}

export const handleStorageSubmission = [
  CaptchaMiddleware.validateCaptchaParams,
  TurnstileMiddleware.validateTurnstileParams,
  ReceiverMiddleware.receiveStorageSubmission,
  EncryptSubmissionMiddleware.validateStorageSubmissionParams,
  encryptSubmission,
  submitEncryptModeForm,
] as ControllerHandler[]

// Validates that the ending date >= starting date
const validateDateRange = celebrate({
  [Segments.QUERY]: Joi.object()
    .keys({
      startDate: Joi.date().format('YYYY-MM-DD').raw(),
      endDate: Joi.date().format('YYYY-MM-DD').min(Joi.ref('startDate')).raw(),
      downloadAttachments: Joi.boolean().default(false),
    })
    .and('startDate', 'endDate'),
})

/**
 * Handler for GET /:formId([a-fA-F0-9]{24})/submissions/download
 * NOTE: This is exported solely for testing
 * Streams and downloads for GET /:formId([a-fA-F0-9]{24})/adminform/submissions/download
 * @security session
 *
 * @returns 200 with stream of encrypted responses
 * @returns 400 if form is not an encrypt mode form
 * @returns 400 if req.query.startDate or req.query.endDate is malformed
 * @returns 403 when user does not have read permissions for form
 * @returns 404 when form cannot be found
 * @returns 410 when form is archived
 * @returns 422 when user in session cannot be retrieved from the database
 * @returns 500 if any errors occurs in stream pipeline or error retrieving form
 */
export const streamEncryptedResponses: ControllerHandler<
  { formId: string },
  unknown,
  unknown,
  { startDate?: string; endDate?: string; downloadAttachments: boolean }
> = async (req, res) => {
  const sessionUserId = (req.session as AuthedSessionData).user._id
  const { formId } = req.params
  const { startDate, endDate } = req.query

  const logMeta = {
    action: 'handleStreamEncryptedResponses',
    ...createReqMeta(req),
    formId,
    sessionUserId,
  }

  logger.info({
    message: 'Stream encrypted responses start',
    meta: logMeta,
  })

  // Step 1: Retrieve currently logged in user.
  const cursorResult = await getPopulatedUserById(sessionUserId)
    .andThen((user) =>
      // Step 2: Check whether user has read permissions to form
      getFormAfterPermissionChecks({
        user,
        formId,
        level: PermissionLevel.Read,
      }),
    )
    // Step 3: Check whether form is encrypt mode.
    .andThen(checkFormIsEncryptMode)
    // Step 4: Retrieve submissions cursor.
    .andThen(() =>
      getSubmissionCursor(formId, {
        startDate,
        endDate,
      }),
    )

  if (cursorResult.isErr()) {
    logger.error({
      message: 'Error occurred whilst retrieving submission cursor',
      meta: logMeta,
      error: cursorResult.error,
    })

    const { statusCode, errorMessage } = mapRouteError(cursorResult.error)
    return res.status(statusCode).json({
      message: errorMessage,
    })
  }

  const cursor = cursorResult.value

  cursor
    .on('error', (error) => {
      logger.error({
        message: 'Error streaming submissions from database',
        meta: logMeta,
        error,
      })
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        message: 'Error retrieving from database.',
      })
    })
    .pipe(
      transformAttachmentMetaStream({
        enabled: req.query.downloadAttachments,
        urlValidDuration: (req.session?.cookie.maxAge ?? 0) / 1000,
      }),
    )
    // TODO: Can we include this within the cursor query as aggregation pipeline
    // instead, so that we make one query to mongo rather than two.
    .pipe(addPaymentDataStream())
    .on('error', (error) => {
      logger.error({
        message: 'Error retrieving URL for attachments',
        meta: logMeta,
        error,
      })
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        message: 'Error retrieving URL for attachments',
      })
    })
    // If you call JSONStream.stringify(false) the elements will only be
    // seperated by a newline.
    .pipe(JSONStream.stringify(false))
    .on('error', (error) => {
      logger.error({
        message: 'Error converting submissions to JSON',
        meta: logMeta,
        error,
      })
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        message: 'Error converting submissions to JSON',
      })
    })
    .pipe(res.type('application/x-ndjson'))
    .on('error', (error) => {
      logger.error({
        message: 'Error writing submissions to HTTP stream',
        meta: logMeta,
        error,
      })
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        message: 'Error writing submissions to HTTP stream',
      })
    })
    .on('close', () => {
      logger.info({
        message: 'Stream encrypted responses closed',
        meta: logMeta,
      })

      return res.end()
    })
}

// Handler for GET /:formId([a-fA-F0-9]{24})/submissions/download
export const handleStreamEncryptedResponses = [
  validateDateRange,
  streamEncryptedResponses,
] as ControllerHandler[]

/**
 * Handler for GET /:formId/submissions/:submissionId
 * @security session
 *
 * @returns 200 with encrypted submission data response
 * @returns 400 when form is not an encrypt mode form
 * @returns 403 when user does not have read permissions for form
 * @returns 404 when submissionId cannot be found in the database
 * @returns 404 when form cannot be found
 * @returns 410 when form is archived
 * @returns 422 when user in session cannot be retrieved from the database
 * @returns 500 when any errors occurs in database query, generating signed URL or retrieving payment data
 */
export const handleGetEncryptedResponse: ControllerHandler<
  { formId: string; submissionId: string },
  StorageModeSubmissionDto | ErrorDto
> = async (req, res) => {
  const sessionUserId = (req.session as AuthedSessionData).user._id
  const { formId, submissionId } = req.params

  const logMeta = {
    action: 'handleGetEncryptedResponse',
    submissionId,
    formId,
    sessionUserId,
    ...createReqMeta(req),
  }

  logger.info({
    message: 'Get encrypted response using submissionId start',
    meta: logMeta,
  })

  return (
    // Step 1: Retrieve logged in user.
    getPopulatedUserById(sessionUserId)
      // Step 2: Check whether user has read permissions to form.
      .andThen((user) =>
        getFormAfterPermissionChecks({
          user,
          formId,
          level: PermissionLevel.Read,
        }),
      )
      // Step 3: Check whether form is encrypt mode.
      .andThen(checkFormIsEncryptMode)
      // Step 4: Is encrypt mode form, retrieve submission data.
      .andThen(() => getEncryptedSubmissionData(formId, submissionId))
      // Step 5: If there is an associated payment, get the payment details.
      .andThen((submissionData) => {
        if (!submissionData.paymentId) {
          return okAsync({ submissionData, paymentData: undefined })
        }

        return getSubmissionPaymentDto(submissionData.paymentId).map(
          (paymentData) => ({
            submissionData,
            paymentData,
          }),
        )
      })
      // Step 6: Retrieve presigned URLs for attachments.
      .andThen(({ submissionData, paymentData }) => {
        // Remaining login duration in seconds.
        const urlExpiry = (req.session?.cookie.maxAge ?? 0) / 1000
        return transformAttachmentMetasToSignedUrls(
          submissionData.attachmentMetadata,
          urlExpiry,
        ).map((presignedUrls) =>
          createEncryptedSubmissionDto(
            submissionData,
            presignedUrls,
            paymentData,
          ),
        )
      })
      .map((responseData) => {
        logger.info({
          message: 'Get encrypted response using submissionId success',
          meta: logMeta,
        })
        return res.json(responseData)
      })
      .mapErr((error) => {
        logger.error({
          message: 'Failure retrieving encrypted submission response',
          meta: logMeta,
          error,
        })

        const { statusCode, errorMessage } = mapRouteError(error)
        return res.status(statusCode).json({
          message: errorMessage,
        })
      })
  )
}

/**
 * Handler for GET /:formId/submissions/metadata
 * This is exported solely for testing purposes
 *
 * @returns 200 with single submission metadata if query.submissionId is provided
 * @returns 200 with list of submission metadata with total count (and optional offset if query.page is provided) if query.submissionId is not provided
 * @returns 400 if form is not an encrypt mode form
 * @returns 403 when user does not have read permissions for form
 * @returns 404 when form cannot be found
 * @returns 410 when form is archived
 * @returns 422 when user in session cannot be retrieved from the database
 * @returns 500 if any errors occurs whilst querying database
 */
export const getMetadata: ControllerHandler<
  { formId: string },
  StorageModeSubmissionMetadataList | ErrorDto,
  unknown,
  FormSubmissionMetadataQueryDto
> = async (req, res) => {
  const sessionUserId = (req.session as AuthedSessionData).user._id
  const { formId } = req.params
  const { page, submissionId } = req.query

  const logMeta = {
    action: 'handleGetMetadata',
    formId,
    submissionId,
    page,
    sessionUserId,
    ...createReqMeta(req),
  }

  return (
    // Step 1: Retrieve logged in user.
    getPopulatedUserById(sessionUserId)
      .andThen((user) =>
        // Step 2: Check whether user has read permissions to form.
        getFormAfterPermissionChecks({
          user,
          formId,
          level: PermissionLevel.Read,
        }),
      )
      // Step 3: Check whether form is encrypt mode.
      .andThen(checkFormIsEncryptMode)
      // Step 4: Retrieve submission metadata.
      .andThen(() => {
        // Step 4a: Retrieve specific submission id.
        if (submissionId) {
          return getSubmissionMetadata(formId, submissionId).map((metadata) => {
            const metadataList: StorageModeSubmissionMetadataList = metadata
              ? { metadata: [metadata], count: 1 }
              : { metadata: [], count: 0 }
            return metadataList
          })
        }
        // Step 4b: Retrieve all submissions of given form id.
        return getSubmissionMetadataList(formId, page)
      })
      .map((metadataList) => {
        logger.info({
          message: 'Successfully retrieved metadata from database',
          meta: logMeta,
        })
        return res.json(metadataList)
      })
      .mapErr((error) => {
        logger.error({
          message: 'Failure retrieving metadata from database',
          meta: logMeta,
          error,
        })

        const { statusCode, errorMessage } = mapRouteError(error)
        return res.status(statusCode).json({
          message: errorMessage,
        })
      })
  )
}

// Handler for GET /:formId/submissions/metadata
export const handleGetMetadata = [
  // NOTE: If submissionId is set, then page is optional.
  // Otherwise, if there is no submissionId, then page >= 1
  celebrate({
    [Segments.QUERY]: {
      submissionId: Joi.string().optional(),
      page: Joi.number().min(1).when('submissionId', {
        not: Joi.exist(),
        then: Joi.required(),
      }),
    },
  }),
  getMetadata,
] as ControllerHandler[]
