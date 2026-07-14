{"@type":"create","object":"Account","value":{"alice":{"@type":"User","name":"alice","domainId":"${DOMAIN_ID}","description":"Integration test mailbox alice","credentials":{"0":{"@type":"Password","secret":"${TEST_ACCOUNT_PASSWORD}"}}}}}
{"@type":"create","object":"Account","value":{"bob":{"@type":"User","name":"bob","domainId":"${DOMAIN_ID}","description":"Integration test mailbox bob","credentials":{"0":{"@type":"Password","secret":"${TEST_ACCOUNT_PASSWORD}"}}}}}
{"@type":"create","object":"Account","value":{"carol":{"@type":"User","name":"carol","domainId":"${DOMAIN_ID}","description":"Integration test mailbox carol","credentials":{"0":{"@type":"Password","secret":"${TEST_ACCOUNT_PASSWORD}"}}}}}
{"@type":"create","object":"Account","value":{"team":{"@type":"Group","name":"team","domainId":"${DOMAIN_ID}","description":"Team shared mailbox"}}}
{"@type":"create","object":"NetworkListener","value":{"submission":{"name":"submission","protocol":"smtp","bind":{"[::]:587":true},"tlsImplicit":false,"useTls":false,"socketReuseAddress":true,"socketNoDelay":true}}}
{"@type":"create","object":"NetworkListener","value":{"imap":{"name":"imap","protocol":"imap","bind":{"[::]:143":true},"tlsImplicit":false,"useTls":false,"socketReuseAddress":true,"socketNoDelay":true}}}
{"@type":"update","object":"MtaStageAuth","value":{"saslMechanisms":{"match":{"0":{"if":"local_port != 25","then":"[plain, login, oauthbearer, xoauth2]"}},"else":"false"}}}
{"@type":"update","object":"Imap","value":{"allowPlainTextAuth":true}}
{"@type":"update","object":"Http","value":{"usePermissiveCors":true}}
