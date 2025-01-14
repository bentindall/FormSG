import { useCallback, useEffect, useMemo, useState } from 'react'
import { BiLinkExternal } from 'react-icons/bi'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Divider,
  FormControl,
  FormHelperText,
  InputGroup,
  InputLeftAddon,
  InputRightElement,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Skeleton,
  Stack,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  useBreakpointValue,
} from '@chakra-ui/react'
import dedent from 'dedent'

import { featureFlags } from '~shared/constants'

import { BxsCheckCircle, BxsErrorCircle } from '~/assets/icons'

import {
  ADMINFORM_ROUTE,
  ADMINFORM_SETTINGS_SUBROUTE,
  ADMINFORM_USETEMPLATE_ROUTE,
} from '~constants/routes'
import Button from '~components/Button'
import FormLabel from '~components/FormControl/FormLabel'
import IconButton from '~components/IconButton'
import InlineMessage from '~components/InlineMessage'
import Input from '~components/Input'
import Link from '~components/Link'
import { ModalCloseButton } from '~components/Modal'
import { Tab } from '~components/Tabs'
import Textarea from '~components/Textarea'
import { CopyButton } from '~templates/CopyButton'

import { useEnv } from '~features/env/queries'
import { useFeatureFlags } from '~features/feature-flags/queries'
import { useListShortenerMutations } from '~features/link-shortener/mutations'
import { useGoLink } from '~features/link-shortener/queries'
import { useUser } from '~features/user/queries'

type goLinkHelperTextType = {
  color: string
  icon: JSX.Element
  text: JSX.Element
}

const goLinkClaimSuccessHelperText: goLinkHelperTextType = {
  color: 'success.700',
  icon: <BxsCheckCircle />,
  text: (
    <Text>
      You have successfully claimed this link. This link will appear in your{' '}
      <Link isExternal href="https://go.gov.sg">
        Go account
      </Link>
    </Text>
  ),
}

const goLinkClaimFailureHelperText: goLinkHelperTextType = {
  color: 'danger.500',
  icon: <BxsErrorCircle />,
  text: <Text>Short link is already in use.</Text>,
}

export interface ShareFormModalProps {
  isOpen: boolean
  onClose: () => void
  /**
   * ID of form to generate share link for. If not provided, modal will be in a
   * loading state
   */
  formId: string | undefined
  isFormPrivate: boolean | undefined
}

export const ShareFormModal = ({
  isOpen,
  onClose,
  formId,
  isFormPrivate,
}: ShareFormModalProps): JSX.Element => {
  const navigate = useNavigate()
  const modalSize = useBreakpointValue({
    base: 'mobile',
    xs: 'mobile',
    md: 'md',
  })

  const { data: { goGovBaseUrl } = {} } = useEnv()

  const { data: flags } = useFeatureFlags()
  const displayGoLink = flags?.has(featureFlags.goLinks)

  // Hard-coded .gov.sg whitelist for GoGov integration
  const gogovWhiteListed = '.gov.sg'
  const { user } = useUser()
  const whitelisted = useMemo(
    () => user?.email.endsWith(gogovWhiteListed),
    [user?.email],
  )

  const shareLink = useMemo(
    () => `${window.location.origin}/${formId}`,
    [formId],
  )

  const templateLink = useMemo(
    () =>
      `${window.location.origin}${ADMINFORM_ROUTE}/${formId}/${ADMINFORM_USETEMPLATE_ROUTE}`,
    [formId],
  )

  const embeddedHtml = useMemo(() => {
    return dedent(`
      <div
        style="
          font-family: Sans-Serif;
          font-size: 15px;
          color: #000;
          opacity: 0.9;
          padding-top: 5px;
          padding-bottom: 8px;
        "
      >
        If the form below is not loaded, you can also fill it in at
        <a href="${shareLink}">here</a>.
      </div>

      <!-- Change the width and height values to suit you best -->
      <iframe
        id="iframe"
        src="${shareLink}"
        style="width: 100%; height: 500px"
      ></iframe>

      <div
        style="
          font-family: Sans-Serif;
          font-size: 12px;
          color: #999;
          opacity: 0.5;
          padding-top: 5px;
        "
      >
        Powered by <a href="${window.location.origin}" style="color: #999">Form</a>
      </div>
    `)
  }, [shareLink])

  const handleRedirectToSettings = useCallback(() => {
    onClose()
    navigate(`${ADMINFORM_ROUTE}/${formId}/${ADMINFORM_SETTINGS_SUBROUTE}`)
  }, [formId, navigate, onClose])

  const { data: goLinkSuffixData } = useGoLink(formId ?? '')
  const [goLinkSuffixInput, setGoLinkSuffixInput] = useState('')
  const [goLinkSaved, setGoLinkSaved] = useState(false)
  const [claimGoLoading, setClaimGoLoading] = useState(false)

  useEffect(() => {
    if (goLinkSuffixData?.goLinkSuffix) {
      setGoLinkSaved(true)
      setGoLinkSuffixInput(goLinkSuffixData?.goLinkSuffix ?? '')
      setGoLinkHelperText(goLinkClaimSuccessHelperText)
    }
  }, [goLinkSuffixData?.goLinkSuffix])

  const { claimGoLinkMutation } = useListShortenerMutations()

  const [goLinkHelperText, setGoLinkHelperText] = useState<
    goLinkHelperTextType | undefined
  >()

  const handleClaimGoLinkClick = useCallback(async () => {
    try {
      if (!user) throw Error('User not loaded yet')

      setClaimGoLoading(true)
      await claimGoLinkMutation.mutateAsync({
        linkSuffix: goLinkSuffixInput,
        formId: formId ?? '',
        adminEmail: user.email,
      })
      setClaimGoLoading(false)
      setGoLinkSaved(true)
      setGoLinkHelperText(goLinkClaimSuccessHelperText)
      return
    } catch (err) {
      setClaimGoLoading(false)
      setGoLinkHelperText(goLinkClaimFailureHelperText)
      return
    }
  }, [user, claimGoLinkMutation, goLinkSuffixInput, formId])

  const FormLinkSection = () => (
    <FormControl isReadOnly>
      <FormLabel isRequired>Form link</FormLabel>
      <Skeleton isLoaded={!!formId}>
        <Stack direction="row" align="center">
          <InputGroup>
            <Input
              // The link will always change in Chromatic so this should be ignored.
              data-chromatic="ignore"
              isReadOnly
              value={shareLink}
            />
            {formId ? (
              <InputRightElement>
                <CopyButton
                  colorScheme="secondary"
                  stringToCopy={shareLink}
                  aria-label="Copy respondent form link"
                />
              </InputRightElement>
            ) : null}
          </InputGroup>
          <IconButton
            as="a"
            icon={<BiLinkExternal fontSize="1.5rem" />}
            href={shareLink}
            target="_blank"
            rel="noopener"
            aria-label="Open link in new tab"
          />
        </Stack>
      </Skeleton>
    </FormControl>
  )

  const TemplateSection = () => (
    <FormControl isReadOnly>
      <FormLabel isRequired>Share template</FormLabel>
      <Skeleton isLoaded={!!formId}>
        <InputGroup>
          <Input
            // The link will always change in Chromatic so this should be ignored.
            data-chromatic="ignore"
            isReadOnly
            isDisabled={isFormPrivate}
            value={`${templateLink}`}
          />
          {formId ? (
            <InputRightElement>
              <CopyButton
                colorScheme="secondary"
                stringToCopy={`${templateLink}`}
                aria-label="Copy link to use this form as a template"
                isDisabled={isFormPrivate}
              />
            </InputRightElement>
          ) : null}
        </InputGroup>
      </Skeleton>
    </FormControl>
  )

  const EmbedSection = () => (
    <FormControl isReadOnly>
      <FormLabel isRequired>Embed HTML</FormLabel>
      <Skeleton isLoaded={!!formId}>
        <InputGroup>
          <Textarea
            pr="2.75rem"
            fontFamily="monospace"
            textStyle="body-1"
            isReadOnly
            value={embeddedHtml}
          />
          {formId ? (
            <InputRightElement>
              <CopyButton
                bg="white"
                colorScheme="secondary"
                stringToCopy={embeddedHtml}
                aria-label="Copy HTML code for embedding this form"
              />
            </InputRightElement>
          ) : null}
        </InputGroup>
      </Skeleton>
    </FormControl>
  )

  return (
    <Modal size={modalSize} isOpen={isOpen} onClose={onClose}>
      <ModalOverlay />
      <ModalContent>
        <ModalCloseButton />
        <ModalHeader color="secondary.700">Share form</ModalHeader>
        <ModalBody whiteSpace="pre-wrap">
          {isFormPrivate ? (
            <InlineMessage variant="warning" mb="1rem">
              <Box>
                This form is currently closed to new responses. Activate your
                form in{' '}
                <Button p={0} variant="link" onClick={handleRedirectToSettings}>
                  Settings
                </Button>{' '}
                to allow new responses or to share it as a template.
              </Box>
            </InlineMessage>
          ) : null}
          <Tabs pos="relative" h="100%" display="flex" flexDir="column" isLazy>
            <Box bg="white">
              <TabList mx="-0.25rem" w="100%">
                <Tab>Link</Tab>
                <Tab>Template</Tab>
                <Tab>Embed</Tab>
              </TabList>
              <Divider w="auto" />
            </Box>
            <TabPanels mt="1.5rem" pb="2rem" flex={1} overflowY="auto">
              <TabPanel>
                <FormLinkSection />
                {/* GoLinkSection */}
                {(displayGoLink && whitelisted) ||
                goLinkSuffixData?.goLinkSuffix ? (
                  <FormControl mt="1rem">
                    <FormLabel
                      isRequired
                      description="Create an official short link and share it over the Internet."
                    >
                      Go link
                    </FormLabel>
                    <Skeleton isLoaded={!!formId}>
                      <Stack direction="row" align="center">
                        <InputGroup>
                          <InputLeftAddon children={`go.gov.sg/`} />
                          <Input
                            value={goLinkSuffixInput}
                            onChange={(e) => {
                              setGoLinkSuffixInput(e.target.value)
                              setGoLinkHelperText(undefined)
                            }}
                            isReadOnly={goLinkSaved}
                          />
                          {goLinkSaved ? (
                            <InputRightElement>
                              <CopyButton
                                colorScheme="secondary"
                                stringToCopy={`${goGovBaseUrl}/${goLinkSuffixInput}`}
                                aria-label="Copy respondent form link"
                              />
                            </InputRightElement>
                          ) : null}
                        </InputGroup>
                        {goLinkSaved ? null : (
                          <Button
                            aria-label="Claim Go link"
                            onClick={handleClaimGoLinkClick}
                            isDisabled={!goLinkSuffixInput}
                            isLoading={claimGoLoading}
                          >
                            Claim
                          </Button>
                        )}
                      </Stack>
                      {goLinkHelperText && (
                        <FormHelperText color={goLinkHelperText.color}>
                          <Stack direction="row" align="center">
                            <Box>{goLinkHelperText.icon}</Box>
                            <Box>{goLinkHelperText.text}</Box>
                          </Stack>
                        </FormHelperText>
                      )}
                    </Skeleton>
                  </FormControl>
                ) : null}
              </TabPanel>
              <TabPanel>
                <TemplateSection />
              </TabPanel>
              <TabPanel>
                <EmbedSection />
              </TabPanel>
            </TabPanels>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
